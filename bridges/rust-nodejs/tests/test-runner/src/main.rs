//! Stitch integration test runner for the Rust→Node.js bridge.
//!
//! Spawns `tests/test-child.js` via `node` and exercises each method.
//! Run with:
//!   cargo run --manifest-path bridges/rust-nodejs/tests/test-runner/Cargo.toml
//!
//! The binary resolves test-child.js relative to the manifest directory.

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
// Wire types
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

// ---------------------------------------------------------------------------
// Bridge (inline, no workspace dep on template.client)
// ---------------------------------------------------------------------------

type PendingMap = Arc<Mutex<HashMap<String, SyncSender<RpcResponse>>>>;

struct Bridge {
    child: Child,
    writer: Option<BufWriter<ChildStdin>>,
    pending: PendingMap,
}

impl Bridge {
    fn spawn(sidecar: &str) -> Self {
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

        // Wait for ready handshake.
        let mut line = String::new();
        reader.read_line(&mut line).expect("failed reading ready");
        let v: Value = serde_json::from_str(line.trim()).expect("ready line not JSON");
        assert_eq!(v["ready"], Value::Bool(true), "expected ready handshake");

        // Reader thread.
        let pend2 = Arc::clone(&pending);
        thread::spawn(move || {
            for line in reader.lines() {
                let raw = match line {
                    Err(_) => break,
                    Ok(r) => r,
                };
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
        writeln!(w, "{line}").expect("write failed");
        w.flush().expect("flush failed");

        let resp = rx.recv_timeout(Duration::from_secs(10)).expect("timeout");
        if let Some(e) = resp.error {
            Err((e.code, e.message))
        } else {
            Ok(resp.result.unwrap_or(Value::Null))
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
// Locate test-child.js
// ---------------------------------------------------------------------------

fn sidecar_path() -> String {
    // Prefer TEST_NODE_SCRIPT env var so the integration test can override.
    if let Ok(p) = std::env::var("TEST_NODE_SCRIPT") {
        return p;
    }
    // CARGO_MANIFEST_DIR is tests/test-runner/; test-child.js is at tests/.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .unwrap()
        .join("test-child.js")
        .to_string_lossy()
        .into_owned()
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

macro_rules! pass {
    ($name:expr) => {
        println!("  PASS  {}", $name);
    };
}

macro_rules! fail {
    ($name:expr, $msg:expr) => {{
        eprintln!("  FAIL  {} - {}", $name, $msg);
        std::process::exit(1);
    }};
}

// ---------------------------------------------------------------------------
// Individual tests
// ---------------------------------------------------------------------------

fn test_ping(b: &mut Bridge) {
    let name = "__ping__ returns pong";
    match b.call("__ping__", json!({})) {
        Ok(r) if r["pong"] == true => pass!(name),
        Ok(r) => fail!(name, format!("unexpected result: {r}")),
        Err((c, m)) => fail!(name, format!("error {c}: {m}")),
    }
}

fn test_echo(b: &mut Bridge) {
    let name = "echo round-trip";
    match b.call("echo", json!({ "msg": "hello Stitch" })) {
        Ok(r) if r["msg"] == "hello Stitch" => pass!(name),
        Ok(r) => fail!(name, format!("unexpected result: {r}")),
        Err((c, m)) => fail!(name, format!("error {c}: {m}")),
    }
}

fn test_add(b: &mut Bridge) {
    let name = "add numbers";
    match b.call("add", json!({ "a": 40, "b": 2 })) {
        Ok(r) if r["sum"] == json!(42.0) => pass!(name),
        Ok(r) => fail!(name, format!("expected sum=42 got {r}")),
        Err((c, m)) => fail!(name, format!("error {c}: {m}")),
    }
}

fn test_raise_error(b: &mut Bridge) {
    let name = "raise_error returns RPC error";
    match b.call("raise_error", json!({})) {
        Err((code, msg)) if code == -32_000 && msg.contains("deliberate test error") => {
            pass!(name)
        }
        Err((c, m)) => fail!(name, format!("wrong error {c}: {m}")),
        Ok(r) => fail!(name, format!("expected error but got result: {r}")),
    }
}

fn test_slow(b: &mut Bridge) {
    let name = "slow method (200 ms)";
    let start = std::time::Instant::now();
    match b.call("slow", json!({ "ms": 200 })) {
        Ok(r) if r["slept_ms"] == json!(200) => {
            let elapsed = start.elapsed();
            if elapsed >= Duration::from_millis(190) {
                pass!(name);
            } else {
                fail!(name, format!("elapsed only {:?}", elapsed));
            }
        }
        Ok(r) => fail!(name, format!("unexpected result: {r}")),
        Err((c, m)) => fail!(name, format!("error {c}: {m}")),
    }
}

fn test_unknown_method(b: &mut Bridge) {
    let name = "unknown method returns -32601";
    match b.call("no_such_method", json!({})) {
        Err((code, _)) if code == -32_601 => pass!(name),
        Err((c, m)) => fail!(name, format!("wrong code {c}: {m}")),
        Ok(r) => fail!(name, format!("expected error but got: {r}")),
    }
}

fn test_sequential_calls(b: &mut Bridge) {
    let name = "sequential calls (20 iterations)";
    for i in 0..20_u64 {
        match b.call("add", json!({ "a": i, "b": 1 })) {
            Ok(r) if r["sum"] == json!((i + 1) as f64) => {}
            Ok(r) => fail!(name, format!("iteration {i}: unexpected result {r}")),
            Err((c, m)) => fail!(name, format!("iteration {i}: error {c}: {m}")),
        }
    }
    pass!(name);
}

fn test_concurrent(sidecar: &str) {
    let name = "concurrent bridges (4 threads)";
    let handles: Vec<_> = (0..4_u64)
        .map(|i| {
            let s = sidecar.to_string();
            thread::spawn(move || {
                let mut b = Bridge::spawn(&s);
                let result = b.call("add", json!({ "a": i, "b": i }));
                b.close();
                (i, result)
            })
        })
        .collect();

    for h in handles {
        let (i, result) = h.join().unwrap();
        match result {
            Ok(r) if r["sum"] == json!((i * 2) as f64) => {}
            Ok(r) => fail!(name, format!("thread {i}: unexpected result {r}")),
            Err((c, m)) => fail!(name, format!("thread {i}: error {c}: {m}")),
        }
    }
    pass!(name);
}

fn test_stdin_eof(sidecar: &str) {
    let name = "stdin EOF causes clean exit";
    let mut b = Bridge::spawn(sidecar);
    // Perform one real call so we know the sidecar is fully alive.
    let _ = b.call("echo", json!({ "msg": "pre-eof" }));
    b.close();
    // Give Node.js a moment to flush and exit.
    thread::sleep(Duration::from_millis(400));
    match b.child.try_wait() {
        Ok(Some(status)) => {
            if status.success() {
                pass!(name);
            } else {
                fail!(name, format!("exited with status {status}"));
            }
        }
        Ok(None) => fail!(name, "child still running after stdin EOF"),
        Err(e) => fail!(name, format!("try_wait error: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    let sidecar = sidecar_path();
    println!("Stitch Rust→Node.js test runner");
    println!("sidecar: {sidecar}");
    println!();

    {
        let mut b = Bridge::spawn(&sidecar);
        test_ping(&mut b);
        test_echo(&mut b);
        test_add(&mut b);
        test_raise_error(&mut b);
        test_slow(&mut b);
        test_unknown_method(&mut b);
        test_sequential_calls(&mut b);
    }

    test_concurrent(&sidecar);
    test_stdin_eof(&sidecar);

    println!();
    println!("All tests passed.");
}
