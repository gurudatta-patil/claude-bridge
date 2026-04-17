//! Ghost-Bridge integration tests: Rust client ↔ Go sidecar.
//!
//! These tests require a pre-built `test-child` binary.  Build it first:
//!
//!   cd tests/test-child && go build -o ../test-child-bin .
//!
//! Then set the env var:
//!
//!   TEST_CHILD_BIN=tests/test-child-bin cargo test
//!
//! or run via the helper script:
//!
//!   ./scripts/run-integration-tests.sh

#[cfg(test)]
mod bridge_tests {
    use std::{
        collections::HashMap,
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };

    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};
    use std::sync::mpsc::{sync_channel, SyncSender};
    use uuid::Uuid;

    // ── Minimal bridge (self-contained, no workspace dep) ─────────────────

    #[derive(Debug, Serialize)]
    struct RpcRequest {
        id: String,
        method: String,
        params: Value,
    }

    #[derive(Debug, Deserialize, Clone)]
    struct RpcSuccess {
        id: String,
        result: Value,
    }

    #[derive(Debug, Deserialize, Clone)]
    struct RpcErrorObject {
        code: i64,
        message: String,
    }

    #[derive(Debug, Deserialize, Clone)]
    struct RpcErrorResponse {
        id: String,
        error: RpcErrorObject,
    }

    #[derive(Debug, Clone)]
    enum RpcResponse {
        Ok(Value),
        Err { code: i64, message: String },
    }

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum WireMessage {
        Ready { ready: bool },
        Success(RpcSuccess),
        Error(RpcErrorResponse),
    }

    struct Bridge {
        child: std::process::Child,
        stdin: std::process::ChildStdin,
        pending: Arc<Mutex<HashMap<String, SyncSender<RpcResponse>>>>,
    }

    impl Bridge {
        fn spawn(bin: &str) -> Self {
            let mut child = Command::new(bin)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap_or_else(|e| panic!("spawn {bin}: {e}"));

            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let pending: Arc<Mutex<HashMap<String, SyncSender<RpcResponse>>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let pending_r = Arc::clone(&pending);
            let (ready_tx, ready_rx) = sync_channel::<bool>(1);

            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                let mut ready_sent = false;
                for line in reader.lines() {
                    match line {
                        Err(_) => {
                            if !ready_sent {
                                let _ = ready_tx.send(false);
                                ready_sent = true;
                            }
                            break;
                        }
                        Ok(raw) if raw.trim().is_empty() => {}
                        Ok(raw) => match serde_json::from_str::<WireMessage>(&raw) {
                            Ok(WireMessage::Ready { ready: true }) => {
                                if !ready_sent {
                                    let _ = ready_tx.send(true);
                                    ready_sent = true;
                                }
                            }
                            Ok(WireMessage::Success(s)) => {
                                let mut m = pending_r.lock().unwrap();
                                if let Some(tx) = m.remove(&s.id) {
                                    let _ = tx.send(RpcResponse::Ok(s.result));
                                }
                            }
                            Ok(WireMessage::Error(e)) => {
                                let mut m = pending_r.lock().unwrap();
                                if let Some(tx) = m.remove(&e.id) {
                                    let _ = tx.send(RpcResponse::Err {
                                        code: e.error.code,
                                        message: e.error.message,
                                    });
                                }
                            }
                            _ => {}
                        },
                    }
                }
                if !ready_sent {
                    let _ = ready_tx.send(false);
                }
                let mut m = pending_r.lock().unwrap();
                for (_, tx) in m.drain() {
                    let _ = tx.send(RpcResponse::Err {
                        code: -32000,
                        message: "child exited".into(),
                    });
                }
            });

            assert!(
                ready_rx
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap_or(false),
                "child did not signal ready"
            );

            Bridge { child, stdin, pending }
        }

        fn call(&mut self, method: &str, params: Value) -> RpcResponse {
            let id = Uuid::new_v4().to_string();
            let (tx, rx) = sync_channel::<RpcResponse>(1);
            self.pending.lock().unwrap().insert(id.clone(), tx);
            let mut line = serde_json::to_string(&RpcRequest {
                id: id.clone(),
                method: method.into(),
                params,
            })
            .unwrap();
            line.push('\n');
            self.stdin.write_all(line.as_bytes()).unwrap();
            self.stdin.flush().unwrap();
            rx.recv_timeout(Duration::from_secs(15))
                .unwrap_or(RpcResponse::Err { code: -1, message: "timeout".into() })
        }

        fn shutdown(mut self) {
            drop(self.stdin);
            let _ = self.child.wait();
        }
    }

    impl Drop for Bridge {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    // ── Utility: resolve the test-child binary path ────────────────────────

    fn test_child_bin() -> String {
        std::env::var("TEST_CHILD_BIN").unwrap_or_else(|_| {
            // Fall back to a path relative to this file's directory.
            let manifest = std::env::var("CARGO_MANIFEST_DIR")
                .unwrap_or_else(|_| ".".to_string());
            format!("{manifest}/../test-child/test-child")
        })
    }

    // ── Tests: round-trip ─────────────────────────────────────────────────

    #[test]
    fn test_echo_round_trip() {
        let bin = test_child_bin();
        let mut b = Bridge::spawn(&bin);
        match b.call("echo", json!({"text": "hello"})) {
            RpcResponse::Ok(v) => assert_eq!(v["text"], "hello"),
            RpcResponse::Err { message, .. } => panic!("unexpected error: {message}"),
        }
        b.shutdown();
    }

    #[test]
    fn test_echo_empty_string() {
        let bin = test_child_bin();
        let mut b = Bridge::spawn(&bin);
        match b.call("echo", json!({"text": ""})) {
            RpcResponse::Ok(v) => assert_eq!(v["text"], ""),
            RpcResponse::Err { message, .. } => panic!("unexpected error: {message}"),
        }
        b.shutdown();
    }

    #[test]
    fn test_add_positive() {
        let bin = test_child_bin();
        let mut b = Bridge::spawn(&bin);
        match b.call("add", json!({"a": 21, "b": 21})) {
            RpcResponse::Ok(v) => assert_eq!(v["sum"].as_i64().unwrap(), 42),
            RpcResponse::Err { message, .. } => panic!("unexpected error: {message}"),
        }
        b.shutdown();
    }

    #[test]
    fn test_add_negative() {
        let bin = test_child_bin();
        let mut b = Bridge::spawn(&bin);
        match b.call("add", json!({"a": -100, "b": 55})) {
            RpcResponse::Ok(v) => assert_eq!(v["sum"].as_i64().unwrap(), -45),
            RpcResponse::Err { message, .. } => panic!("unexpected error: {message}"),
        }
        b.shutdown();
    }

    // ── Tests: error propagation ──────────────────────────────────────────

    #[test]
    fn test_raise_error_propagates_code() {
        let bin = test_child_bin();
        let mut b = Bridge::spawn(&bin);
        match b.call("raise_error", json!({"code": -32099, "message": "deliberate"})) {
            RpcResponse::Err { code, .. } => assert_eq!(code, -32099),
            RpcResponse::Ok(v) => panic!("expected error, got Ok({v})"),
        }
        b.shutdown();
    }

    #[test]
    fn test_method_not_found() {
        let bin = test_child_bin();
        let mut b = Bridge::spawn(&bin);
        match b.call("does_not_exist", json!(null)) {
            RpcResponse::Err { code, .. } => assert_eq!(code, -32601),
            RpcResponse::Ok(v) => panic!("expected error, got Ok({v})"),
        }
        b.shutdown();
    }

    // ── Tests: concurrent calls ───────────────────────────────────────────
    //
    // We use multiple Bridge instances (each wrapping its own child process)
    // and call them from separate threads, then join and verify results.
    // This validates that the UUID-keyed dispatch mechanism is correct.

    #[test]
    fn test_concurrent_bridges() {
        let bin = test_child_bin();
        let n = 8usize;

        // Wrap the bin string in an Arc so threads can share it.
        let bin = Arc::new(bin);

        let handles: Vec<_> = (0..n)
            .map(|i| {
                let bin = Arc::clone(&bin);
                thread::spawn(move || {
                    let mut b = Bridge::spawn(&bin);
                    let result = b.call("add", json!({"a": i, "b": 1}));
                    b.shutdown();
                    (i, result)
                })
            })
            .collect();

        for h in handles {
            let (i, result) = h.join().expect("thread panicked");
            match result {
                RpcResponse::Ok(v) => {
                    assert_eq!(
                        v["sum"].as_i64().unwrap(),
                        (i + 1) as i64,
                        "unexpected sum for i={i}"
                    );
                }
                RpcResponse::Err { code, message } => {
                    panic!("call failed for i={i}: {code}: {message}");
                }
            }
        }
    }

    // ── Tests: large payload (bufio.Scanner buffer) ───────────────────────

    #[test]
    fn test_echo_b64_large_payload() {
        let bin = test_child_bin();
        let mut b = Bridge::spawn(&bin);

        // 128 KB of 0xFF → base64 is ~171 KB — exceeds the Go default 64 KB
        // scanner buffer if it has not been enlarged.
        let data: Vec<u8> = vec![0xFFu8; 128 * 1024];
        let encoded = base64_encode(&data);

        match b.call("echo_b64", json!({"data": encoded})) {
            RpcResponse::Ok(v) => {
                assert_eq!(v["data"].as_str().unwrap(), encoded.as_str());
            }
            RpcResponse::Err { code, message } => {
                panic!("large payload error {code}: {message}");
            }
        }
        b.shutdown();
    }

    // ── Tests: stdin-EOF triggers clean exit ─────────────────────────────

    #[test]
    fn test_stdin_eof_exits_cleanly() {
        let bin = test_child_bin();

        let mut child = Command::new(&bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();

        // Consume the ready line.
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(
            line.contains("ready"),
            "expected ready line, got: {line}"
        );

        // Closing stdin → EOF in the child.
        drop(child.stdin.take());

        // The child should exit within 3 seconds.
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait().unwrap() {
                Some(status) => {
                    assert!(status.success(), "child exited with failure: {status}");
                    return;
                }
                None if std::time::Instant::now() >= deadline => {
                    child.kill().ok();
                    panic!("child did not exit after stdin EOF within 3 s");
                }
                None => thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    // ── Tests: multiple sequential calls on one bridge ────────────────────

    #[test]
    fn test_sequential_calls_reuse_bridge() {
        let bin = test_child_bin();
        let mut b = Bridge::spawn(&bin);

        for i in 0i64..20 {
            match b.call("add", json!({"a": i, "b": 10})) {
                RpcResponse::Ok(v) => {
                    assert_eq!(v["sum"].as_i64().unwrap(), i + 10);
                }
                RpcResponse::Err { code, message } => {
                    panic!("iteration {i} failed {code}: {message}");
                }
            }
        }

        b.shutdown();
    }

    // ── Tests: slow method (no spurious timeout) ──────────────────────────

    #[test]
    fn test_slow_method_completes() {
        let bin = test_child_bin();
        let mut b = Bridge::spawn(&bin);
        match b.call("slow", json!({"ms": 300})) {
            RpcResponse::Ok(v) => assert_eq!(v["slept_ms"].as_i64().unwrap(), 300),
            RpcResponse::Err { message, .. } => panic!("unexpected error: {message}"),
        }
        b.shutdown();
    }

    // ── Helper: minimal base64 encoder ────────────────────────────────────

    fn base64_encode(input: &[u8]) -> String {
        const A: &[u8] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::with_capacity(((input.len() + 2) / 3) * 4);
        for c in input.chunks(3) {
            let b0 = c[0] as u32;
            let b1 = c.get(1).copied().unwrap_or(0) as u32;
            let b2 = c.get(2).copied().unwrap_or(0) as u32;
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(A[((n >> 18) & 0x3F) as usize]);
            out.push(A[((n >> 12) & 0x3F) as usize]);
            out.push(if c.len() > 1 { A[((n >> 6) & 0x3F) as usize] } else { b'=' });
            out.push(if c.len() > 2 { A[(n & 0x3F) as usize] } else { b'=' });
        }
        String::from_utf8(out).unwrap()
    }
}
