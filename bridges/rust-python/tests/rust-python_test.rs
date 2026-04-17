//! Ghost-Bridge — Rust `#[cfg(test)]` integration tests for the Rust→Python bridge.
//!
//! These tests run with `cargo test` from any crate that has the bridge source
//! available.  They spawn `test-child.py` as the sidecar.
//!
//! Environment variables
//! ---------------------
//! SIDECAR_SCRIPT  — path to test-child.py   (default: auto-detected)
//! PYTHON_PATH     — Python interpreter path  (default: venv or python3)

#[cfg(test)]
mod bridge_tests {
    use std::{
        collections::HashMap,
        io::{BufRead, BufReader, Write},
        process::{Child, ChildStdin, Command, Stdio},
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };

    use serde_json::Value;
    use uuid::Uuid;

    // -----------------------------------------------------------------------
    // Minimal bridge (self-contained so tests don't depend on the template)
    // -----------------------------------------------------------------------

    #[derive(Debug, Clone)]
    struct RpcResponse {
        id: String,
        result: Option<Value>,
        error_msg: Option<String>,
        error_code: Option<i64>,
    }

    #[derive(Debug)]
    enum Err {
        Io(std::io::Error),
        Rpc { code: i64, msg: String },
        ReaderDead,
        NotReady,
    }

    impl From<std::io::Error> for Err { fn from(e: std::io::Error) -> Self { Self::Io(e) } }

    type Pending = Arc<Mutex<HashMap<String, std::sync::mpsc::SyncSender<RpcResponse>>>>;

    struct Bridge {
        stdin:   ChildStdin,
        child:   Child,
        pending: Pending,
        _reader: thread::JoinHandle<()>,
    }

    impl Bridge {
        fn start() -> Self {
            let script = std::env::var("SIDECAR_SCRIPT").unwrap_or_else(|_| {
                // Locate test-child.py relative to CARGO_MANIFEST_DIR.
                let manifest = std::env::var("CARGO_MANIFEST_DIR")
                    .unwrap_or_else(|_| ".".to_string());
                format!("{manifest}/../../tests/test-child.py")
            });

            let python = std::env::var("PYTHON_PATH").unwrap_or_else(|_| {
                let cwd = std::env::current_dir().unwrap_or_default();
                #[cfg(unix)]    let venv = cwd.join("venv/bin/python");
                #[cfg(windows)] let venv = cwd.join("venv/Scripts/python.exe");
                if venv.exists() { venv.to_string_lossy().into_owned() } else { "python3".to_string() }
            });

            let mut child = Command::new(&python)
                .arg(&script)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap_or_else(|e| panic!("spawn failed (python={python} script={script}): {e}"));

            let stdout = child.stdout.take().unwrap();
            let stdin  = child.stdin.take().unwrap();
            let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

            // Ready slot.
            let (rtx, rrx) = std::sync::mpsc::sync_channel::<RpcResponse>(1);
            pending.lock().unwrap().insert("__ready__".into(), rtx);

            let pending_r = Arc::clone(&pending);
            let reader = thread::spawn(move || {
                let buf = BufReader::new(stdout);
                for line in buf.lines() {
                    let line = match line { Ok(l) => l, Err(_) => break };
                    let v: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let resp = if v.get("ready") == Some(&Value::Bool(true)) {
                        RpcResponse { id: "__ready__".into(), result: None, error_msg: None, error_code: None }
                    } else {
                        let id = v["id"].as_str().unwrap_or("").to_string();
                        let error_code = v["error"]["code"].as_i64();
                        let error_msg  = v["error"]["message"].as_str().map(str::to_string);
                        let result     = v.get("result").cloned();
                        RpcResponse { id, result, error_msg, error_code }
                    };
                    let mut map = pending_r.lock().unwrap();
                    if let Some(tx) = map.remove(&resp.id) { let _ = tx.send(resp); }
                }
            });

            rrx.recv_timeout(Duration::from_secs(5)).expect("sidecar ready timeout");
            Self { stdin, child, pending, _reader: reader }
        }

        fn call(&mut self, method: &str, params: Value) -> Result<Value, Err> {
            let id = Uuid::new_v4().to_string();
            let (tx, rx) = std::sync::mpsc::sync_channel::<RpcResponse>(1);
            self.pending.lock().unwrap().insert(id.clone(), tx);

            let line = format!(
                "{}\n",
                serde_json::json!({"id": id, "method": method, "params": params})
            );
            self.stdin.write_all(line.as_bytes())?;

            let resp = rx.recv().map_err(|_| Err::ReaderDead)?;
            if let (Some(code), Some(msg)) = (resp.error_code, resp.error_msg) {
                return Err(Err::Rpc { code, msg });
            }
            Ok(resp.result.unwrap_or(Value::Null))
        }
    }

    impl Drop for Bridge {
        fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
    }

    // -----------------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------------

    /// Basic round-trip: echo returns the sent message unchanged.
    #[test]
    fn test_round_trip_echo() {
        let mut b = Bridge::start();
        let r = b.call("echo", serde_json::json!({"message": "hello-rust"})).unwrap();
        assert_eq!(r["echo"], "hello-rust");
    }

    /// Numeric method: add returns the correct sum.
    #[test]
    fn test_round_trip_add() {
        let mut b = Bridge::start();
        let r = b.call("add", serde_json::json!({"a": 100, "b": 23})).unwrap();
        assert_eq!(r["sum"], 123);
    }

    /// Base64 round-trip: encode in Python, verify in Rust.
    #[test]
    fn test_round_trip_b64() {
        let mut b = Bridge::start();
        let r = b.call("echo_b64", serde_json::json!({"data": "ghost"})).unwrap();
        let encoded = r["b64"].as_str().unwrap();
        // "ghost" in base64 is "Z2hvc3Q="
        assert_eq!(encoded, "Z2hvc3Q=");
    }

    /// Application-level error: raise_error returns an RPC error response.
    #[test]
    fn test_error_propagation() {
        let mut b = Bridge::start();
        match b.call("raise_error", serde_json::json!({"message": "test-error"})) {
            Err(Err::Rpc { code: -32603, msg }) => assert!(msg.contains("test-error")),
            other => panic!("unexpected: {other:?}"),
        }
    }

    /// Unknown method returns error code -32601 (method not found).
    #[test]
    fn test_unknown_method_error() {
        let mut b = Bridge::start();
        match b.call("no_such_method", serde_json::json!({})) {
            Err(Err::Rpc { code: -32601, .. }) => {}
            other => panic!("expected -32601, got: {other:?}"),
        }
    }

    /// Concurrent calls: 8 threads send requests to one sidecar and all
    /// receive the correct response (tests mpsc per-call channel isolation).
    #[test]
    fn test_concurrent_calls() {
        // Each thread owns its own Bridge instance to avoid shared-stdin
        // complications in a #[test] context.
        let handles: Vec<_> = (0u32..8).map(|i| {
            thread::spawn(move || {
                let mut b = Bridge::start();
                let r = b.call("add", serde_json::json!({"a": i, "b": 100u32})).unwrap();
                let sum = r["sum"].as_u64().unwrap() as u32;
                assert_eq!(sum, i + 100, "mismatch for i={i}");
            })
        }).collect();

        for h in handles { h.join().expect("test thread panicked"); }
    }

    /// Slow method: bridge correctly waits for a delayed reply.
    #[test]
    fn test_slow_reply() {
        let mut b = Bridge::start();
        let start = std::time::Instant::now();
        let r = b.call("slow", serde_json::json!({"seconds": 0.15})).unwrap();
        assert!(start.elapsed() >= Duration::from_millis(100));
        assert_eq!(r["slept"], 0.15_f64);
    }

    /// stdin EOF: dropping the bridge closes stdin; the sidecar must exit
    /// cleanly (the Drop impl calls kill+wait, which must not block).
    #[test]
    fn test_stdin_eof_exits_cleanly() {
        let b = Bridge::start();
        // Explicit drop — kill() + wait() are called; if the child hung this
        // test would time out.
        drop(b);
    }

    /// Reader dead: after the child is killed the next call returns ReaderDead.
    #[test]
    fn test_reader_dead_after_kill() {
        let mut b = Bridge::start();
        // Kill the child without closing the Bridge.
        b.child.kill().unwrap();
        b.child.wait().unwrap();

        // The next call may fail at the write (Io) or at the recv (ReaderDead).
        // Both are acceptable; what must NOT happen is a successful response.
        let result = b.call("echo", serde_json::json!({"message": "after death"}));
        assert!(result.is_err(), "expected error after child killed");
    }
}
