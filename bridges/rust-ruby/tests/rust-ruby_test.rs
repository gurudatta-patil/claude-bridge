//! Stitch — Rust→Ruby bridge integration tests.
//!
//! These are `#[cfg(test)]` tests intended to be run from the workspace root:
//!
//!   cargo test --manifest-path bridges/rust-ruby/tests/test-runner/Cargo.toml
//!
//! Or, if you add this file to a top-level integration test target, simply:
//!
//!   cargo test
//!
//! Each test spawns its own `test-child.rb` process so tests are fully isolated.
//! The helper `spawn_bridge()` resolves the sidecar path relative to this file.

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
// Minimal bridge (self-contained so this file can be dropped into any crate)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct RpcRequest<'a> {
    jsonrpc: &'a str,
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
        let mut child = Command::new("ruby")
            .arg(sidecar)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("failed to spawn ruby — is ruby in PATH?");

        let stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let writer = BufWriter::new(stdin);
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        // Ready handshake
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
        let req = RpcRequest { jsonrpc: "2.0", id: id.clone(), method, params };
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
        // Must close stdin BEFORE kill/wait, otherwise Ruby blocks on readline.
        self.close();
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
        }
    }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

fn sidecar_path() -> String {
    // This file lives at tests/rust-ruby_test.rs; test-child.rb is a sibling.
    let here = PathBuf::from(file!());
    // file!() is relative to the crate root at compile time.
    // When running via cargo test from any location, CARGO_MANIFEST_DIR gives us
    // the absolute crate root.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // tests/rust-ruby_test.rs → tests/test-child.rb
    let candidate = manifest.join("tests").join("test-child.rb");
    // Fall back to sibling of this source file (for direct rustc invocations)
    if candidate.exists() {
        return candidate.to_string_lossy().into_owned();
    }
    // Also try one level up from the manifest
    let alt = manifest
        .parent()
        .unwrap_or(&manifest)
        .join("test-child.rb");
    alt.to_string_lossy().into_owned()
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

    /// Basic echo round-trip: value comes back unchanged.
    #[test]
    fn test_echo_round_trip() {
        let mut b = new_bridge();
        let result = b.call("echo", json!({ "value": "hello" })).unwrap();
        assert_eq!(result["value"], "hello");
    }

    /// Numeric payload with Unicode string value.
    #[test]
    fn test_echo_unicode() {
        let mut b = new_bridge();
        let result = b.call("echo", json!({ "value": "こんにちは 🦀" })).unwrap();
        assert_eq!(result["value"], "こんにちは 🦀");
    }

    /// `add` returns correct numeric sum.
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
        // 1.5 + 2.25 = 3.75 exactly in IEEE 754
        let sum = result["sum"].as_f64().unwrap();
        assert!((sum - 3.75).abs() < f64::EPSILON);
    }

    /// `raise_error` method causes the sidecar to return a JSON-RPC error.
    /// The bridge should surface it as Err with code -32603.
    #[test]
    fn test_error_propagation() {
        let mut b = new_bridge();
        let err = b
            .call("raise_error", json!({ "message": "intentional" }))
            .unwrap_err();
        assert_eq!(err.0, -32_603, "expected internal error code");
        assert!(
            err.1.contains("intentional"),
            "error message should contain the raised text"
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
    fn test_concurrent_bridges() {
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

    /// base64 round-trip via `echo_b64`.
    #[test]
    fn test_echo_base64() {
        let input = "Stitch rocks 🦀💎";
        // Rust std doesn't have base64 without a crate; encode manually.
        let encoded = base64_naive_encode(input.as_bytes());
        let mut b = new_bridge();
        let result = b.call("echo_b64", json!({ "data": encoded })).unwrap();
        assert_eq!(result["decoded"], input);
        assert_eq!(result["reencoded"], encoded);
    }

    /// `slow` method returns after the requested sleep; confirms timing.
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

    /// Unknown method returns JSON-RPC error -32601.
    #[test]
    fn test_unknown_method_error() {
        let mut b = new_bridge();
        let err = b.call("does_not_exist", json!({})).unwrap_err();
        assert_eq!(err.0, -32_601, "expected method-not-found code");
    }

    /// Closing stdin (EOF) causes the child to exit cleanly (exit status 0).
    #[test]
    fn test_stdin_eof_clean_exit() {
        let mut b = new_bridge();
        // Do a real call first so we know the child is fully alive.
        let _ = b.call("echo", json!({ "value": "pre-eof" })).unwrap();
        // Close stdin — Ruby's each_line loop terminates.
        b.close();
        // Allow Ruby some time to flush and exit.
        thread::sleep(Duration::from_millis(400));
        let status = b.child.try_wait().expect("try_wait failed");
        assert!(
            status.is_some(),
            "child should have exited after stdin EOF"
        );
        assert!(
            status.unwrap().success(),
            "child should exit with status 0"
        );
    }

    /// After bridge drop, the child process should be gone.
    #[test]
    fn test_drop_kills_child() {
        let mut b = new_bridge();
        let pid = b.child.id();
        drop(b);
        // On Unix we can check /proc/<pid>; cross-platform: just verify no panic.
        // If child lingered the process count would grow — sufficient to assert no error.
        #[cfg(unix)]
        {
            thread::sleep(Duration::from_millis(200));
            let alive = std::path::Path::new(&format!("/proc/{pid}")).exists();
            assert!(!alive, "child pid={pid} should be gone after drop");
        }
        let _ = pid; // suppress unused warning on non-unix
    }

    // -----------------------------------------------------------------------
    // Minimal base64 encoder (no external crate)
    // -----------------------------------------------------------------------
    fn base64_naive_encode(input: &[u8]) -> String {
        const TABLE: &[u8] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let b0 = chunk[0] as usize;
            let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
            out.push(TABLE[b0 >> 2] as char);
            out.push(TABLE[((b0 & 3) << 4) | (b1 >> 4)] as char);
            if chunk.len() > 1 {
                out.push(TABLE[((b1 & 0xf) << 2) | (b2 >> 6)] as char);
            } else {
                out.push('=');
            }
            if chunk.len() > 2 {
                out.push(TABLE[b2 & 0x3f] as char);
            } else {
                out.push('=');
            }
        }
        out
    }
}
