//! Stitch integration test runner.
//!
//! Spawns `tests/test-child.rb` via `ruby` and exercises each method.
//! Run with:
//!   cargo run --manifest-path tests/test-runner/Cargo.toml
//!
//! The binary resolves test-child.rb relative to the workspace root
//! (two levels up from the Cargo.toml).

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
// Wire types (mirrors template.client)
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

// ---------------------------------------------------------------------------
// Bridge (inline copy so test-runner has no workspace dep on template.client)
// ---------------------------------------------------------------------------

type PendingMap = Arc<Mutex<HashMap<String, SyncSender<RpcResponse>>>>;

struct Bridge {
    child: Child,
    writer: Option<BufWriter<ChildStdin>>,
    pending: PendingMap,
}

impl Bridge {
    fn spawn(sidecar: &str) -> Self {
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

        // Wait for ready
        let mut line = String::new();
        reader.read_line(&mut line).expect("failed reading ready");
        let v: Value = serde_json::from_str(line.trim()).expect("ready line not JSON");
        assert_eq!(v["ready"], Value::Bool(true), "expected ready handshake");

        // Reader thread
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
        let req = RpcRequest { jsonrpc: "2.0", id: id.clone(), method, params };
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
    }
}

// ---------------------------------------------------------------------------
// Locate test-child.rb
// ---------------------------------------------------------------------------

fn sidecar_path() -> String {
    // When built with `cargo run` from tests/test-runner/, the manifest dir is
    // tests/test-runner/ and test-child.rb is at tests/test-child.rb.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest.parent().unwrap().join("test-child.rb");
    candidate.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

macro_rules! pass {
    ($name:expr) => {
        println!("  PASS  {}", $name);
    };
}

macro_rules! fail {
    ($name:expr, $msg:expr) => {{
        eprintln!("  FAIL  {} — {}", $name, $msg);
        std::process::exit(1);
    }};
}

fn test_echo(b: &mut Bridge) {
    let name = "echo round-trip";
    match b.call("echo", json!({ "value": "hello Stitch" })) {
        Ok(r) if r["value"] == "hello Stitch" => pass!(name),
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
    match b.call("raise_error", json!({ "message": "boom" })) {
        Err((code, msg)) if code == -32_603 && msg.contains("boom") => pass!(name),
        Err((c, m)) => fail!(name, format!("wrong error {c}: {m}")),
        Ok(r) => fail!(name, format!("expected error but got result: {r}")),
    }
}

fn test_echo_b64(b: &mut Bridge) {
    use std::io::Write as _;
    let name = "echo_b64 base64 round-trip";
    let input = "Stitch rocks 🦀💎";
    let encoded = {
        use std::fmt::Write as FW;
        // use base64 via Ruby to encode — here we just replicate it in Rust
        let bytes = input.as_bytes();
        // simple base64 using the alphabet — we rely on the stdlib in tests
        let encoded = base64_encode(bytes);
        encoded
    };
    match b.call("echo_b64", json!({ "data": encoded })) {
        Ok(r) if r["decoded"] == input => pass!(name),
        Ok(r) => fail!(name, format!("unexpected result: {r}")),
        Err((c, m)) => fail!(name, format!("error {c}: {m}")),
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

fn test_concurrent(sidecar: &str) {
    let name = "concurrent calls (4 threads)";
    // We need separate bridges because Bridge is not Send (ChildStdin isn't).
    // In a real implementation you'd use a channel-based actor.  Here we
    // spawn 4 independent bridge processes to simulate concurrency.
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let s = sidecar.to_string();
            thread::spawn(move || {
                let mut b = Bridge::spawn(&s);
                let result = b.call("add", json!({ "a": i, "b": i }));
                b.close();
                result
            })
        })
        .collect();

    for (i, h) in handles.into_iter().enumerate() {
        match h.join().unwrap() {
            Ok(r) if r["sum"] == json!((i as f64) * 2.0) => {}
            Ok(r) => fail!(name, format!("thread {i} unexpected: {r}")),
            Err((c, m)) => fail!(name, format!("thread {i} error {c}: {m}")),
        }
    }
    pass!(name);
}

fn test_stdin_eof(sidecar: &str) {
    let name = "stdin EOF causes clean exit";
    let mut b = Bridge::spawn(sidecar);
    // Send one call, then close.
    let _ = b.call("echo", json!({ "value": "pre-eof" }));
    b.close();
    // Give Ruby a moment to exit.
    thread::sleep(Duration::from_millis(300));
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
// Tiny base64 encoder (no external crate in test-runner)
// ---------------------------------------------------------------------------

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(TABLE[(b0 >> 2)] as char);
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    let sidecar = sidecar_path();
    println!("Stitch Rust→Ruby test runner");
    println!("sidecar: {sidecar}");
    println!();

    {
        let mut b = Bridge::spawn(&sidecar);
        test_echo(&mut b);
        test_add(&mut b);
        test_raise_error(&mut b);
        test_echo_b64(&mut b);
        test_slow(&mut b);
        test_unknown_method(&mut b);
    }

    test_concurrent(&sidecar);
    test_stdin_eof(&sidecar);

    println!();
    println!("All tests passed.");
}
