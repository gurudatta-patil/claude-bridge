//! Stitch - shared Rust bridge client module.
//!
//! All Rust bridge clients (rust-python, rust-go, rust-ruby) include this
//! module (`mod bridge_client; use bridge_client::*;`) rather than duplicating
//! the pending-map, reader-thread spawn, kill helper, and error types.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    process::{Child, ChildStdout},
    sync::{
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─────────────────────────────────────────────────────────────────────────────
// Wire types
// ─────────────────────────────────────────────────────────────────────────────

/// JSON-RPC error object carried in an error response from the sidecar.
#[derive(Debug, Deserialize, Clone)]
pub struct RpcError {
    pub code: Option<i64>,
    pub message: String,
    pub traceback: Option<String>,
    pub backtrace: Option<String>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// A parsed response line from the sidecar (success or error, identified by id).
#[derive(Debug, Clone)]
pub struct RpcResponse {
    pub id: String,
    pub result: Option<Value>,
    pub error: Option<RpcError>,
}

// ─────────────────────────────────────────────────────────────────────────────
// PendingMap
// ─────────────────────────────────────────────────────────────────────────────

/// Shared pending-call map.  Both the caller thread and the reader thread hold
/// a clone of this `Arc` - the caller inserts, the reader removes and delivers.
pub type PendingMap = Arc<Mutex<HashMap<String, SyncSender<RpcResponse>>>>;

/// Create an empty PendingMap.
pub fn new_pending_map() -> PendingMap {
    Arc::new(Mutex::new(HashMap::new()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader thread
// ─────────────────────────────────────────────────────────────────────────────

/// Spawn a daemon thread that reads newline-delimited JSON from `stdout`,
/// dispatches each response to the matching `SyncSender` in `pending`, and
/// signals `ready_tx` when the first `{"ready":true}` line is seen.
///
/// The returned `JoinHandle` should be stored in the bridge struct so the
/// thread is joined (or at least kept alive) for the bridge's lifetime.
pub fn spawn_reader_thread(
    stdout: ChildStdout,
    pending: PendingMap,
    ready_tx: SyncSender<()>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut ready_sent = false;

        for line in reader.lines() {
            let raw = match line {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[bridge_client] reader IO error: {e}");
                    break;
                }
            };

            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }

            let v: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[bridge_client] malformed JSON: {e} - `{trimmed}`");
                    continue;
                }
            };

            // Ready signal
            if !ready_sent && v.get("ready") == Some(&Value::Bool(true)) {
                ready_sent = true;
                let _ = ready_tx.send(());
                continue;
            }

            // Normal RPC response
            let id = match v.get("id").and_then(Value::as_str) {
                Some(s) => s.to_string(),
                None => {
                    eprintln!("[bridge_client] response missing `id`: {v}");
                    continue;
                }
            };

            let error = v.get("error").and_then(|e| {
                serde_json::from_value::<RpcError>(e.clone()).ok()
            });
            let result = v.get("result").cloned();
            let resp = RpcResponse { id: id.clone(), result, error };

            let mut map = pending.lock().unwrap();
            if let Some(tx) = map.remove(&id) {
                let _ = tx.send(resp);
            } else {
                eprintln!("[bridge_client] unknown response id: {id}");
            }
        }

        // Stdout closed - drain pending callers with an error.
        if !ready_sent {
            let _ = ready_tx.send(());
        }
        let mut map = pending.lock().unwrap();
        for (id, tx) in map.drain() {
            let _ = tx.send(RpcResponse {
                id,
                result: None,
                error: Some(RpcError {
                    code: Some(-32000),
                    message: "child process exited unexpectedly".to_string(),
                    traceback: None,
                    backtrace: None,
                }),
            });
        }
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// kill_child helper
// ─────────────────────────────────────────────────────────────────────────────

/// Kill the child process and wait for it to exit.
/// On Unix: sends SIGKILL directly (callers should close stdin first for a
/// graceful shutdown before resorting to kill_child).
pub fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: make a pending-slot and SyncSender pair
// ─────────────────────────────────────────────────────────────────────────────

/// Register a new call id in `pending` and return the receiver end of a
/// one-shot channel.  The reader thread will deliver to the sender end.
pub fn register_call(
    pending: &PendingMap,
    id: &str,
) -> std::sync::mpsc::Receiver<RpcResponse> {
    let (tx, rx) = sync_channel::<RpcResponse>(1);
    pending.lock().unwrap().insert(id.to_string(), tx);
    rx
}

// ─────────────────────────────────────────────────────────────────────────────
// ping_call convenience function
// ─────────────────────────────────────────────────────────────────────────────

/// Send a `__ping__` call and wait for `{"pong":true,"pid":<n>}`.
/// Returns `Ok(Value)` on success or `Err(String)` on timeout / error.
/// `write_fn` sends a serialised request line to the child's stdin.
pub fn ping_call(
    pending: &PendingMap,
    write_fn: impl Fn(&str) -> Result<(), String>,
) -> Result<Value, String> {
    use std::time::Duration;

    let id = format!("ping-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos());

    let rx = register_call(pending, &id);

    let req = serde_json::json!({
        "id": &id,
        "method": "__ping__",
        "params": {}
    });
    write_fn(&req.to_string())?;

    let resp = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "ping timed out".to_string())?;

    if let Some(err) = resp.error {
        return Err(format!("ping error: {}", err.message));
    }

    resp.result.ok_or_else(|| "ping: no result".to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming support
// ─────────────────────────────────────────────────────────────────────────────

/// A single frame from a streaming sidecar response.
#[derive(Debug)]
pub struct StreamFrame {
    /// The chunk data, present for intermediate frames.
    pub chunk: Option<serde_json::Value>,
    /// Set on the terminal frame (empty Value = stream done).
    pub result: Option<serde_json::Value>,
    /// Set if the stream ended with an error.
    pub error: Option<RpcError>,
}

/// A streaming response iterator yielded by `stream_call`.
/// Each `next()` blocks until the next chunk or terminal frame arrives.
pub struct BridgeStream {
    rx: std::sync::mpsc::Receiver<StreamFrame>,
}

impl BridgeStream {
    pub fn new(rx: std::sync::mpsc::Receiver<StreamFrame>) -> Self {
        Self { rx }
    }
}

impl Iterator for BridgeStream {
    type Item = Result<serde_json::Value, RpcError>;

    fn next(&mut self) -> Option<Self::Item> {
        match self.rx.recv() {
            Ok(frame) => {
                if let Some(err) = frame.error {
                    return Some(Err(err));
                }
                if frame.result.is_some() {
                    return None; // terminal frame = end of stream
                }
                frame.chunk.map(Ok)
            }
            Err(_) => None,
        }
    }
}

/// Shared pending-stream map. Keyed by call id; each entry is a bounded sender
/// for `StreamFrame` values delivered by `spawn_streaming_reader_thread`.
pub type StreamPendingMap = Arc<Mutex<HashMap<String, SyncSender<StreamFrame>>>>;

/// Create an empty StreamPendingMap.
pub fn new_stream_pending_map() -> StreamPendingMap {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Register a new streaming call id in `stream_pending` and return the
/// receiver end of a bounded channel.  The streaming reader thread will
/// deliver `StreamFrame`s to the sender end.
pub fn register_stream_call(
    stream_pending: &StreamPendingMap,
    id: &str,
) -> std::sync::mpsc::Receiver<StreamFrame> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<StreamFrame>(64);
    stream_pending.lock().unwrap().insert(id.to_string(), tx);
    rx
}

/// Like `spawn_reader_thread` but handles both regular and streaming calls.
///
/// - Lines with a `"chunk"` key (and no `"result"` or `"error"`) are chunk
///   frames and are delivered to `stream_pending`.
/// - Lines whose id is present in `stream_pending` (terminal / error on
///   stream) are delivered there and the entry removed.
/// - All other lines are delivered to the regular `pending` map.
pub fn spawn_streaming_reader_thread(
    stdout: ChildStdout,
    pending: PendingMap,
    stream_pending: StreamPendingMap,
    ready_tx: SyncSender<()>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut ready_sent = false;

        for line in reader.lines() {
            let raw = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }

            let v: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[bridge_client] malformed JSON: {e}");
                    continue;
                }
            };

            // Ready signal
            if !ready_sent && v.get("ready") == Some(&Value::Bool(true)) {
                ready_sent = true;
                let _ = ready_tx.send(());
                continue;
            }

            let id = match v.get("id").and_then(Value::as_str) {
                Some(s) => s.to_string(),
                None => continue,
            };

            // Chunk frame (has "chunk", no "result" / "error")
            if v.get("chunk").is_some()
                && v.get("result").is_none()
                && v.get("error").is_none()
            {
                let sp = stream_pending.lock().unwrap();
                if let Some(tx) = sp.get(&id) {
                    let frame = StreamFrame {
                        chunk: v.get("chunk").cloned(),
                        result: None,
                        error: None,
                    };
                    let _ = tx.send(frame);
                }
                continue;
            }

            let error = v
                .get("error")
                .and_then(|e| serde_json::from_value::<RpcError>(e.clone()).ok());
            let result = v.get("result").cloned();

            // Terminal stream frame or stream error
            {
                let mut sp = stream_pending.lock().unwrap();
                if let Some(tx) = sp.remove(&id) {
                    let frame = StreamFrame { chunk: None, result, error };
                    let _ = tx.send(frame);
                    continue;
                }
            }

            // Regular pending call
            let resp = RpcResponse { id: id.clone(), result, error };
            let mut map = pending.lock().unwrap();
            if let Some(tx) = map.remove(&id) {
                let _ = tx.send(resp);
            } else {
                eprintln!("[bridge_client] unknown response id: {id}");
            }
        }

        // Drain remaining callers with a "child exited" error.
        if !ready_sent {
            let _ = ready_tx.send(());
        }
        let mut map = pending.lock().unwrap();
        for (id, tx) in map.drain() {
            let _ = tx.send(RpcResponse {
                id,
                result: None,
                error: Some(RpcError {
                    code: Some(-32000),
                    message: "child exited".to_string(),
                    traceback: None,
                    backtrace: None,
                }),
            });
        }
        let mut sp = stream_pending.lock().unwrap();
        for (_, tx) in sp.drain() {
            let _ = tx.send(StreamFrame {
                chunk: None,
                result: None,
                error: Some(RpcError {
                    code: Some(-32000),
                    message: "child exited".to_string(),
                    traceback: None,
                    backtrace: None,
                }),
            });
        }
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// SupervisedBridge wrapper
// ─────────────────────────────────────────────────────────────────────────────

/// Wraps a bridge and restarts the child on unexpected exit.
///
/// # Example
/// ```rust,no_run
/// let supervised = SupervisedBridge::new(|| GoBridge::spawn("./sidecar", &[]), 3);
/// ```
pub struct SupervisedBridge<T, F>
where
    F: Fn() -> Result<T, String> + Send + 'static,
{
    factory: F,
    max_restarts: u32,
    restart_count: u32,
    inner: Option<T>,
}

impl<T, F> SupervisedBridge<T, F>
where
    F: Fn() -> Result<T, String> + Send + 'static,
{
    pub fn new(factory: F, max_restarts: u32) -> Result<Self, String> {
        let inner = factory()?;
        Ok(Self {
            factory,
            max_restarts,
            restart_count: 0,
            inner: Some(inner),
        })
    }

    /// Attempt to restart the inner bridge after unexpected failure.
    /// Returns Err if max_restarts has been reached.
    pub fn restart(&mut self) -> Result<(), String> {
        if self.restart_count >= self.max_restarts {
            return Err(format!(
                "max restarts ({}) reached",
                self.max_restarts
            ));
        }
        let delay_ms = 100u64 * (1 << self.restart_count.min(7));
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        self.restart_count += 1;
        eprintln!(
            "[supervised] restarting child (attempt {}/{})",
            self.restart_count, self.max_restarts
        );
        self.inner = Some((self.factory)()?);
        Ok(())
    }

    /// Get a reference to the inner bridge.
    pub fn inner(&self) -> Option<&T> {
        self.inner.as_ref()
    }

    /// Get a mutable reference to the inner bridge.
    pub fn inner_mut(&mut self) -> Option<&mut T> {
        self.inner.as_mut()
    }
}
