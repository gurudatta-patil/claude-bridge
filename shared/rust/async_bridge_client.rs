//! Stitch - async Rust bridge client (Tokio).
//!
//! Requires the following in `Cargo.toml`:
//! ```toml
//! [dependencies]
//! tokio = { version = "1", features = ["full"] }
//! tokio-util = { version = "0.7", features = ["codec"] }
//! serde = { version = "1", features = ["derive"] }
//! serde_json = "1"
//! uuid = { version = "1", features = ["v4"] }
//! ```
//!
//! # Example
//! ```rust,no_run
//! #[tokio::main]
//! async fn main() {
//!     let mut bridge = AsyncBridge::spawn("python", &["sidecar.py"]).await.unwrap();
//!     let result = bridge.call("add", serde_json::json!({"a": 1, "b": 2})).await.unwrap();
//!     println!("{result}");
//!
//!     let mut stream = bridge.stream("generate", serde_json::json!({"prompt": "hi"})).await.unwrap();
//!     while let Some(chunk) = stream.next().await {
//!         println!("{}", chunk.unwrap());
//!     }
//!
//!     bridge.close().await;
//! }
//! ```

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{
    mpsc::{self, UnboundedSender},
    oneshot, Mutex,
};

// ─────────────────────────────────────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────────────────────────────────────

/// A JSON-RPC error returned by the sidecar process.
#[derive(Debug, Clone)]
pub struct AsyncRpcError {
    pub code: Option<i64>,
    pub message: String,
    pub traceback: Option<String>,
    pub backtrace: Option<String>,
}

impl std::fmt::Display for AsyncRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AsyncRpcError {}

impl From<AsyncRpcError> for String {
    fn from(e: AsyncRpcError) -> Self {
        e.message
    }
}

fn parse_rpc_error(v: &Value) -> AsyncRpcError {
    AsyncRpcError {
        code: v.get("code").and_then(Value::as_i64),
        message: v
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error")
            .to_string(),
        traceback: v
            .get("traceback")
            .and_then(Value::as_str)
            .map(String::from),
        backtrace: v
            .get("backtrace")
            .and_then(Value::as_str)
            .map(String::from),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal dispatch tables
// ─────────────────────────────────────────────────────────────────────────────

/// Oneshot sender for regular (non-streaming) calls.
type CallSender = oneshot::Sender<Result<Value, AsyncRpcError>>;

/// Unbounded sender for streaming calls.  The reader task drops the sender
/// (by removing it from the map) on the terminal / error frame, which closes
/// the channel and signals EOF to the consumer.
type StreamSender = UnboundedSender<Result<Value, AsyncRpcError>>;

#[derive(Default)]
struct Dispatch {
    calls: HashMap<String, CallSender>,
    streams: HashMap<String, StreamSender>,
}

type SharedDispatch = Arc<Mutex<Dispatch>>;

// ─────────────────────────────────────────────────────────────────────────────
// AsyncStream - manual async iterator over stream chunks
// ─────────────────────────────────────────────────────────────────────────────

/// An async stream of chunks returned by [`AsyncBridge::stream`].
///
/// Poll with `.next().await` until `None` is returned (end of stream).
pub struct AsyncStream {
    rx: mpsc::UnboundedReceiver<Result<Value, AsyncRpcError>>,
}

impl AsyncStream {
    /// Returns the next chunk, or `None` when the stream is exhausted.
    pub async fn next(&mut self) -> Option<Result<Value, AsyncRpcError>> {
        self.rx.recv().await
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AsyncBridge
// ─────────────────────────────────────────────────────────────────────────────

/// An async Tokio-based bridge client.
///
/// Spawns a sidecar child process and communicates with it over
/// newline-delimited JSON on stdin / stdout.
pub struct AsyncBridge {
    stdin: ChildStdin,
    child: Child,
    dispatch: SharedDispatch,
    /// Background reader task handle - kept alive for the lifetime of the bridge.
    _reader: tokio::task::JoinHandle<()>,
}

impl AsyncBridge {
    // ── Construction ────────────────────────────────────────────────────────

    /// Spawn `program` with `args`, wait for the `{"ready":true}` handshake,
    /// and return a connected `AsyncBridge`.
    pub async fn spawn(program: &str, args: &[&str]) -> Result<Self, String> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to spawn '{program}': {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;

        let dispatch: SharedDispatch = Arc::new(Mutex::new(Dispatch::default()));

        // ready channel - signalled by the reader task when it sees {"ready":true}
        let (ready_tx, ready_rx) = oneshot::channel::<()>();

        let reader_dispatch = Arc::clone(&dispatch);
        let _reader = tokio::spawn(Self::reader_loop(
            BufReader::new(stdout),
            reader_dispatch,
            ready_tx,
        ));

        // Wait for the ready handshake (5-second timeout)
        tokio::time::timeout(std::time::Duration::from_secs(5), ready_rx)
            .await
            .map_err(|_| "timed out waiting for sidecar ready signal".to_string())
            .and_then(|r| r.map_err(|_| "sidecar closed before ready".to_string()))?;

        Ok(Self { stdin, child, dispatch, _reader })
    }

    // ── Reader loop (runs as a Tokio task) ──────────────────────────────────

    async fn reader_loop(
        mut reader: BufReader<tokio::process::ChildStdout>,
        dispatch: SharedDispatch,
        ready_tx: oneshot::Sender<()>,
    ) {
        let mut ready_sent = false;
        // Wrap in Option so we can consume (send) it exactly once.
        let mut ready_tx = Some(ready_tx);
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break, // EOF or IO error
                Ok(_) => {}
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let v: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[async_bridge] malformed JSON: {e}");
                    continue;
                }
            };

            // Ready signal
            if !ready_sent && v.get("ready") == Some(&Value::Bool(true)) {
                ready_sent = true;
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(());
                }
                continue;
            }

            let id = match v.get("id").and_then(Value::as_str) {
                Some(s) => s.to_string(),
                None => continue,
            };

            // ── Chunk frame ─────────────────────────────────────────────────
            // A chunk frame carries "chunk" but neither "result" nor "error".
            if v.get("chunk").is_some()
                && v.get("result").is_none()
                && v.get("error").is_none()
            {
                let dp = dispatch.lock().await;
                if let Some(tx) = dp.streams.get(&id) {
                    let chunk = v.get("chunk").cloned().unwrap_or(Value::Null);
                    let _ = tx.send(Ok(chunk));
                }
                continue;
            }

            // ── Terminal / error frame ──────────────────────────────────────
            let is_error = v.get("error").is_some();
            let result = v.get("result").cloned();
            let error = v
                .get("error")
                .map(|e| parse_rpc_error(e));

            // Check stream dispatch first
            {
                let mut dp = dispatch.lock().await;
                if let Some(tx) = dp.streams.remove(&id) {
                    if let Some(err) = error {
                        let _ = tx.send(Err(err));
                    }
                    // Drop tx - this closes the channel signalling EOF.
                    drop(tx);
                    continue;
                }
            }

            // Regular call dispatch
            {
                let mut dp = dispatch.lock().await;
                if let Some(tx) = dp.calls.remove(&id) {
                    let payload = if is_error {
                        Err(error.unwrap_or(AsyncRpcError {
                            code: None,
                            message: "unknown error".to_string(),
                            traceback: None,
                            backtrace: None,
                        }))
                    } else {
                        Ok(result.unwrap_or(Value::Null))
                    };
                    let _ = tx.send(payload);
                } else {
                    eprintln!("[async_bridge] unknown response id: {id}");
                }
            }
        }

        // EOF reached - drain all pending waiters.
        if let Some(tx) = ready_tx.take() {
            let _ = tx.send(());
        }

        let mut dp = dispatch.lock().await;
        let exit_err = || AsyncRpcError {
            code: Some(-32000),
            message: "child process exited unexpectedly".to_string(),
            traceback: None,
            backtrace: None,
        };

        for (_, tx) in dp.calls.drain() {
            let _ = tx.send(Err(exit_err()));
        }
        for (_, tx) in dp.streams.drain() {
            let _ = tx.send(Err(exit_err()));
            // Drop tx to close the channel.
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /// Generate a unique call id.
    fn new_id() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static CTR: AtomicU64 = AtomicU64::new(1);
        format!("call-{}", CTR.fetch_add(1, Ordering::Relaxed))
    }

    /// Write a JSON line to the child's stdin.
    async fn write_line(&mut self, value: &Value) -> Result<(), String> {
        let mut line = value.to_string();
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("stdin write error: {e}"))
    }

    /// Invoke `method` with `params` and wait for a single result value.
    pub async fn call(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, AsyncRpcError> {
        let id = Self::new_id();

        let (tx, rx) = oneshot::channel::<Result<Value, AsyncRpcError>>();
        {
            let mut dp = self.dispatch.lock().await;
            dp.calls.insert(id.clone(), tx);
        }

        let req = serde_json::json!({
            "id": &id,
            "method": method,
            "params": params,
        });
        self.write_line(&req).await.map_err(|e| AsyncRpcError {
            code: None,
            message: e,
            traceback: None,
            backtrace: None,
        })?;

        rx.await.unwrap_or_else(|_| {
            Err(AsyncRpcError {
                code: Some(-32000),
                message: "reader task dropped before responding".to_string(),
                traceback: None,
                backtrace: None,
            })
        })
    }

    /// Invoke `method` with `params` and return an [`AsyncStream`] that yields
    /// each chunk as it arrives.  The stream ends when the sidecar sends a
    /// terminal frame.
    pub async fn stream(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<AsyncStream, AsyncRpcError> {
        let id = Self::new_id();

        let (tx, rx) = mpsc::unbounded_channel::<Result<Value, AsyncRpcError>>();
        {
            let mut dp = self.dispatch.lock().await;
            dp.streams.insert(id.clone(), tx);
        }

        let req = serde_json::json!({
            "id": &id,
            "method": method,
            "params": params,
            "stream": true,
        });
        self.write_line(&req).await.map_err(|e| AsyncRpcError {
            code: None,
            message: e,
            traceback: None,
            backtrace: None,
        })?;

        Ok(AsyncStream { rx })
    }

    /// Convenience: send `__ping__` and return the pong response.
    pub async fn ping(&mut self) -> Result<Value, AsyncRpcError> {
        self.call("__ping__", serde_json::json!({})).await
    }

    /// Gracefully shut down the bridge: close stdin and wait for the child.
    pub async fn close(mut self) {
        // Drop stdin so the child sees EOF and can shut down cleanly.
        drop(self.stdin);
        let _ = self.child.wait().await;
    }

    /// Kill the child process immediately and wait for it to exit.
    pub async fn kill(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}
