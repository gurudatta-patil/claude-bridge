//! Stitch — shared Rust bridge client module.
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
/// a clone of this `Arc` — the caller inserts, the reader removes and delivers.
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
                    eprintln!("[bridge_client] malformed JSON: {e} — `{trimmed}`");
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

        // Stdout closed — drain pending callers with an error.
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
