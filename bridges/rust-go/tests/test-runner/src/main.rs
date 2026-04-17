//! Stitch test runner.
//!
//! This binary builds the test-child Go sidecar (if `go` is on PATH), then
//! exercises every supported method and validates results.  It is intentionally
//! a standalone binary rather than `cargo test` so that it can orchestrate the
//! `go build` step and produce human-readable output.

use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::mpsc::{sync_channel, SyncSender};
use uuid::Uuid;

// ── Minimal bridge re-implementation (identical to template client) ───────────
// We keep it local so the test runner has zero workspace dependencies.

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
    pending: Arc<Mutex<std::collections::HashMap<String, SyncSender<RpcResponse>>>>,
}

impl Bridge {
    fn spawn(path: &str) -> Self {
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|e| panic!("Failed to spawn {path}: {e}"));

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let pending: Arc<Mutex<std::collections::HashMap<String, SyncSender<RpcResponse>>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let pending_r = Arc::clone(&pending);
        let (ready_tx, ready_rx) = sync_channel::<bool>(1);

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut ready_sent = false;
            for line in reader.lines() {
                match line {
                    Err(e) => {
                        eprintln!("[runner reader] IO error: {e}");
                        if !ready_sent {
                            let _ = ready_tx.send(false);
                            ready_sent = true;
                        }
                        break;
                    }
                    Ok(raw) => {
                        if raw.trim().is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<WireMessage>(&raw) {
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
                        }
                    }
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

        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(true) => {}
            _ => panic!("Child did not signal ready"),
        }

        Bridge { child, stdin, pending }
    }

    fn call(&mut self, method: &str, params: Value) -> RpcResponse {
        let id = Uuid::new_v4().to_string();
        let req = RpcRequest { id: id.clone(), method: method.into(), params };
        let (tx, rx) = sync_channel::<RpcResponse>(1);
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let mut line = serde_json::to_string(&req).unwrap();
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

// ── Test helpers ──────────────────────────────────────────────────────────────

struct TestResults {
    passed: usize,
    failed: usize,
}

impl TestResults {
    fn new() -> Self {
        Self { passed: 0, failed: 0 }
    }

    fn pass(&mut self, name: &str) {
        self.passed += 1;
        println!("  PASS  {name}");
    }

    fn fail(&mut self, name: &str, reason: &str) {
        self.failed += 1;
        println!("  FAIL  {name}: {reason}");
    }

    fn assert_ok(&mut self, name: &str, resp: RpcResponse, expected: Value) {
        match resp {
            RpcResponse::Ok(v) if v == expected => self.pass(name),
            RpcResponse::Ok(v) => self.fail(name, &format!("got {v}, want {expected}")),
            RpcResponse::Err { code, message } => {
                self.fail(name, &format!("unexpected error {code}: {message}"))
            }
        }
    }

    fn assert_err(&mut self, name: &str, resp: RpcResponse, expected_code: i64) {
        match resp {
            RpcResponse::Err { code, .. } if code == expected_code => self.pass(name),
            RpcResponse::Err { code, message } => {
                self.fail(name, &format!("wrong error code {code} (want {expected_code}): {message}"))
            }
            RpcResponse::Ok(v) => self.fail(name, &format!("expected error, got Ok({v})")),
        }
    }

    fn summary(&self) {
        println!("\n── Results ──────────────────────────────");
        println!("  Passed: {}", self.passed);
        println!("  Failed: {}", self.failed);
        println!("─────────────────────────────────────────\n");
    }
}

// ── Build helper ─────────────────────────────────────────────────────────────

fn build_test_child() -> PathBuf {
    // Resolve path relative to this file's directory at compile time.
    let manifest = env!("CARGO_MANIFEST_DIR");
    let child_dir = PathBuf::from(manifest).join("../test-child");
    let out_bin = child_dir.join("test-child");

    println!("[runner] Building test-child Go binary...");
    let status = Command::new("go")
        .args(["build", "-o", out_bin.to_str().unwrap(), "."])
        .current_dir(&child_dir)
        .status()
        .expect("Failed to invoke `go build` — is Go installed?");

    if !status.success() {
        panic!("go build failed with status {status}");
    }
    println!("[runner] Build successful: {}", out_bin.display());
    out_bin
}

// ── Test suite ────────────────────────────────────────────────────────────────

fn run_tests(bin: &str) {
    let mut results = TestResults::new();

    // ── Basic round-trip tests ─────────────────────────────────────────────
    println!("\n── Basic method calls ───────────────────");
    {
        let mut b = Bridge::spawn(bin);

        let r = b.call("echo", json!({"text": "hello world"}));
        results.assert_ok("echo/basic", r, json!({"text": "hello world"}));

        let r = b.call("echo", json!({"text": ""}));
        results.assert_ok("echo/empty-string", r, json!({"text": ""}));

        let r = b.call("add", json!({"a": 3, "b": 4}));
        results.assert_ok("add/positive", r, json!({"sum": 7}));

        let r = b.call("add", json!({"a": -10, "b": 5}));
        results.assert_ok("add/negative", r, json!({"sum": -5}));

        let r = b.call("add", json!({"a": 0, "b": 0}));
        results.assert_ok("add/zero", r, json!({"sum": 0}));

        b.shutdown();
    }

    // ── Error handling ─────────────────────────────────────────────────────
    println!("\n── Error handling ───────────────────────");
    {
        let mut b = Bridge::spawn(bin);

        let r = b.call("raise_error", json!({"code": -32099, "message": "test error"}));
        results.assert_err("raise_error/custom-code", r, -32099);

        let r = b.call("nonexistent_method", json!(null));
        results.assert_err("dispatch/method-not-found", r, -32601);

        b.shutdown();
    }

    // ── Base64 round-trip ──────────────────────────────────────────────────
    println!("\n── Base64 / binary payload ──────────────");
    {
        let mut b = Bridge::spawn(bin);

        // "Hello, Stitch!" base64-encoded
        let encoded = base64_encode(b"Hello, Stitch!");
        let r = b.call("echo_b64", json!({"data": encoded}));
        results.assert_ok("echo_b64/basic", r, json!({"data": encoded}));

        // Large payload (128 KB of 0xFF bytes)
        let large: Vec<u8> = vec![0xFFu8; 128 * 1024];
        let large_b64 = base64_encode(&large);
        let r = b.call("echo_b64", json!({"data": large_b64}));
        match r {
            RpcResponse::Ok(v) => {
                let got = v["data"].as_str().unwrap_or("").to_string();
                if got == large_b64 {
                    results.pass("echo_b64/large-128kb");
                } else {
                    results.fail("echo_b64/large-128kb", "data mismatch");
                }
            }
            RpcResponse::Err { code, message } => {
                results.fail("echo_b64/large-128kb", &format!("error {code}: {message}"))
            }
        }

        b.shutdown();
    }

    // ── Concurrent calls ───────────────────────────────────────────────────
    println!("\n── Concurrent calls ─────────────────────");
    {
        // We can't share a single `Bridge` across threads (not Send) so we
        // fire N sequential calls and verify all responses arrive with the
        // correct data.  True concurrency testing is in rust-go_test.rs.
        let mut b = Bridge::spawn(bin);
        let n = 50;
        let mut all_ok = true;
        for i in 0..n {
            let r = b.call("add", json!({"a": i, "b": 1}));
            match r {
                RpcResponse::Ok(v) => {
                    let got = v["sum"].as_i64().unwrap_or(-999);
                    if got != i + 1 {
                        all_ok = false;
                        results.fail(
                            &format!("concurrent/add-{i}"),
                            &format!("expected {} got {}", i + 1, got),
                        );
                    }
                }
                RpcResponse::Err { code, message } => {
                    all_ok = false;
                    results.fail(&format!("concurrent/add-{i}"), &format!("{code}: {message}"));
                }
            }
        }
        if all_ok {
            results.pass(&format!("concurrent/all-{n}-sequential-add-calls"));
        }
        b.shutdown();
    }

    // ── Slow method (timeout safety) ───────────────────────────────────────
    println!("\n── Slow method ──────────────────────────");
    {
        let mut b = Bridge::spawn(bin);
        // slow sleeps 200 ms — well within our 15 s call timeout.
        let r = b.call("slow", json!({"ms": 200}));
        results.assert_ok("slow/200ms", r, json!({"slept_ms": 200}));
        b.shutdown();
    }

    // ── stdin-EOF clean exit ───────────────────────────────────────────────
    println!("\n── stdin-EOF exit ───────────────────────");
    {
        let mut child = Command::new(bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        // Read the ready line.
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("ready"), "expected ready line, got: {line}");
        // Drop stdin → EOF in child.
        drop(child.stdin.take());
        let status = child
            .wait_timeout(Duration::from_secs(5))
            .expect("wait failed");
        match status {
            Some(s) if s.success() => results.pass("stdin-eof/clean-exit"),
            Some(s) => results.fail("stdin-eof/clean-exit", &format!("exit status: {s}")),
            None => results.fail("stdin-eof/clean-exit", "child did not exit within 5 s"),
        }
    }

    results.summary();
    if results.failed > 0 {
        std::process::exit(1);
    }
}

// ── Tiny base64 encoder (no external dep) ────────────────────────────────────

fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(((input.len() + 2) / 3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 0x3F) as usize]);
        out.push(ALPHABET[((n >> 12) & 0x3F) as usize]);
        out.push(if chunk.len() > 1 { ALPHABET[((n >> 6) & 0x3F) as usize] } else { b'=' });
        out.push(if chunk.len() > 2 { ALPHABET[(n & 0x3F) as usize] } else { b'=' });
    }
    String::from_utf8(out).unwrap()
}

// ── wait_timeout extension (std doesn't have it) ─────────────────────────────

trait WaitTimeout {
    fn wait_timeout(&mut self, d: Duration) -> std::io::Result<Option<std::process::ExitStatus>>;
}

impl WaitTimeout for std::process::Child {
    fn wait_timeout(&mut self, d: Duration) -> std::io::Result<Option<std::process::ExitStatus>> {
        use std::time::Instant;
        let deadline = Instant::now() + d;
        loop {
            match self.try_wait()? {
                Some(s) => return Ok(Some(s)),
                None => {
                    if Instant::now() >= deadline {
                        return Ok(None);
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    // Allow overriding the binary path via CLI arg or env var.
    let bin_path = env::args()
        .nth(1)
        .or_else(|| env::var("TEST_CHILD_BIN").ok())
        .unwrap_or_else(|| {
            // Auto-build the test-child Go binary.
            build_test_child().to_string_lossy().into_owned()
        });

    println!("Stitch Test Runner");
    println!("Using sidecar binary: {bin_path}");

    run_tests(&bin_path);
}
