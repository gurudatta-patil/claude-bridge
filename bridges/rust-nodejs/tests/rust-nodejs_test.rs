//! Stitch - Rust→Node.js bridge integration tests.
//!
//! These are `#[cfg(test)]` tests intended to be run from the bridge directory:
//!
//!   cd bridges/rust-nodejs/tests/test-runner
//!   TEST_NODE_SCRIPT=../test-child.js cargo test
//!
//! Each test spawns its own `test-child.js` process so tests are fully isolated.
//! The helper `new_bridge()` resolves the sidecar via `TEST_NODE_SCRIPT` env var
//! or falls back to the sibling `tests/test-child.js`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Minimal bridge (self-contained so this file compiles in any crate)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct RpcRequest<'a> {
    id: String,
    method: &'a str,
    params: Value,
}

#[derive(Debug, Deserialize, Clone)]
struct RpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize, Clone)]
struct RpcResponse {
    id: Option<String>,
    result: Option<Value>,
    error: Option<RpcError>,
}

type PendingMap = Arc<Mutex<HashMap<String, SyncSender<RpcResponse>>>>;

struct Bridge {
    child: Child,
    writer: Option<BufWriter<ChildStdin>>,
    pending: PendingMap,
}

impl Bridge {
    fn spawn_from(sidecar: &str) -> Self {
        let mut child = Command::new("node")
            .arg(sidecar)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("failed to spawn node - is node in PATH?");

        let stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let writer = BufWriter::new(stdin);
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        // Ready handshake.
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let v: Value = serde_json::from_str(line.trim()).expect("ready line not JSON");
        assert_eq!(v["ready"], json!(true));

        let pend2 = Arc::clone(&pending);
        thread::spawn(move || {
            for raw in reader.lines().flatten() {
                if raw.trim().is_empty() {
                    continue;
                }
                if let Ok(resp) = serde_json::from_str::<RpcResponse>(&raw) {
                    if let Some(id) = &resp.id {
                        if let Some(tx) = pend2.lock().unwrap().remove(id) {
                            let _ = tx.send(resp);
                        }
                    }
                }
            }
        });

        Bridge { child, writer: Some(writer), pending }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let id = Uuid::new_v4().to_string();
        let req = RpcRequest { id: id.clone(), method, params };
        let (tx, rx) = sync_channel(1);
        self.pending.lock().unwrap().insert(id.clone(), tx);

        let line = serde_json::to_string(&req).unwrap();
        let w = self.writer.as_mut().expect("bridge closed");
        writeln!(w, "{line}").unwrap();
        w.flush().unwrap();

        match rx.recv_timeout(Duration::from_secs(15)) {
            Err(_) => Err((-32_001, format!("timeout for id={id}"))),
            Ok(resp) => {
                if let Some(e) = resp.error {
                    Err((e.code, e.message))
                } else {
                    Ok(resp.result.unwrap_or(Value::Null))
                }
            }
        }
    }

    fn close(&mut self) {
        drop(self.writer.take());
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.close();
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

fn sidecar_path() -> String {
    // Allow the test environment to override via TEST_NODE_SCRIPT.
    if let Ok(p) = std::env::var("TEST_NODE_SCRIPT") {
        return p;
    }
    // file!() is relative to the crate root; CARGO_MANIFEST_DIR gives the
    // absolute crate root so we can locate the sibling test-child.js.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // tests/rust-nodejs_test.rs  →  tests/test-child.js
    let candidate = manifest.join("tests").join("test-child.js");
    if candidate.exists() {
        return candidate.to_string_lossy().into_owned();
    }
    // When running from tests/test-runner/, the manifest is tests/test-runner/
    // and test-child.js is one level up.
    manifest
        .parent()
        .unwrap_or(&manifest)
        .join("test-child.js")
        .to_string_lossy()
        .into_owned()
}

fn new_bridge() -> Bridge {
    Bridge::spawn_from(&sidecar_path())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Ping/health-check - verifies the built-in __ping__ handler.
    #[test]
    fn test_ping() {
        let mut b = new_bridge();
        let result = b.call("__ping__", json!({})).unwrap();
        assert_eq!(result["pong"], true);
        assert!(result["pid"].is_number(), "pid should be a number");
    }

    /// Basic echo round-trip: msg comes back unchanged.
    #[test]
    fn test_echo_round_trip() {
        let mut b = new_bridge();
        let result = b.call("echo", json!({ "msg": "hello" })).unwrap();
        assert_eq!(result["msg"], "hello");
    }

    /// Unicode strings survive the round-trip.
    #[test]
    fn test_echo_unicode() {
        let mut b = new_bridge();
        let result = b
            .call("echo", json!({ "msg": "こんにちは 🦀" }))
            .unwrap();
        assert_eq!(result["msg"], "こんにちは 🦀");
    }

    /// `add` returns correct integer sum.
    #[test]
    fn test_add_integers() {
        let mut b = new_bridge();
        let result = b.call("add", json!({ "a": 19, "b": 23 })).unwrap();
        assert_eq!(result["sum"], json!(42.0));
    }

    /// `add` works with floating-point inputs.
    #[test]
    fn test_add_floats() {
        let mut b = new_bridge();
        let result = b.call("add", json!({ "a": 1.5, "b": 2.25 })).unwrap();
        let sum = result["sum"].as_f64().unwrap();
        assert!((sum - 3.75).abs() < f64::EPSILON);
    }

    /// `raise_error` causes the sidecar to return a JSON-RPC error.
    #[test]
    fn test_error_bubbling() {
        let mut b = new_bridge();
        let err = b.call("raise_error", json!({})).unwrap_err();
        assert_eq!(err.0, -32_000, "expected generic error code");
        assert!(
            err.1.contains("deliberate test error"),
            "error message should contain the raised text, got: {}",
            err.1
        );
    }

    /// A single bridge can service many sequential requests without re-spawning.
    #[test]
    fn test_sequential_requests_same_bridge() {
        let mut b = new_bridge();
        for i in 0..20_u64 {
            let result = b.call("add", json!({ "a": i, "b": 1 })).unwrap();
            assert_eq!(result["sum"], json!((i + 1) as f64));
        }
    }

    /// Multiple bridges run concurrently across OS threads.
    #[test]
    fn test_concurrent_calls() {
        let sidecar = sidecar_path();
        let handles: Vec<_> = (0..6_u64)
            .map(|i| {
                let s = sidecar.clone();
                thread::spawn(move || {
                    let mut b = Bridge::spawn_from(&s);
                    let r = b.call("add", json!({ "a": i, "b": i })).unwrap();
                    b.close();
                    (i, r["sum"].as_f64().unwrap())
                })
            })
            .collect();

        for h in handles {
            let (i, sum) = h.join().unwrap();
            assert_eq!(sum, (i * 2) as f64, "thread {i}: wrong sum");
        }
    }

    /// Unknown method returns JSON-RPC error -32601.
    #[test]
    fn test_unknown_method_error() {
        let mut b = new_bridge();
        let err = b.call("does_not_exist", json!({})).unwrap_err();
        assert_eq!(err.0, -32_601, "expected method-not-found code");
    }

    /// `slow` resolves after the requested delay.
    #[test]
    fn test_slow_response() {
        let mut b = new_bridge();
        let start = std::time::Instant::now();
        let result = b.call("slow", json!({ "ms": 150 })).unwrap();
        assert_eq!(result["slept_ms"], json!(150));
        assert!(
            start.elapsed() >= Duration::from_millis(140),
            "elapsed too short: {:?}",
            start.elapsed()
        );
    }

    /// Closing stdin (EOF) causes the child to exit cleanly (exit status 0).
    #[test]
    fn test_process_cleanup_on_close() {
        let mut b = new_bridge();
        let _ = b.call("echo", json!({ "msg": "pre-eof" })).unwrap();
        b.close();
        // Allow Node.js time to flush and exit.
        thread::sleep(Duration::from_millis(400));
        let status = b.child.try_wait().expect("try_wait failed");
        assert!(status.is_some(), "child should have exited after stdin EOF");
        assert!(
            status.unwrap().success(),
            "child should exit with status 0"
        );
    }

    /// After bridge drop, the child process should be gone.
    #[test]
    fn test_process_cleanup_on_drop() {
        let mut b = new_bridge();
        let pid = b.child.id();
        drop(b);
        #[cfg(unix)]
        {
            thread::sleep(Duration::from_millis(200));
            let alive = std::path::Path::new(&format!("/proc/{pid}")).exists();
            assert!(!alive, "child pid={pid} should be gone after drop");
        }
        let _ = pid; // suppress unused warning on non-unix
    }
}
