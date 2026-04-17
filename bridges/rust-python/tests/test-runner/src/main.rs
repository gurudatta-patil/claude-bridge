//! Stitch test-runner — exercises all test-child.py methods.
//!
//! Run:
//!   SIDECAR_SCRIPT=../test-child.py cargo run
//! or set PYTHON_PATH for a specific interpreter.

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

// ---------------------------------------------------------------------------
// Minimal inline bridge (same logic as template.client, kept self-contained)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct RpcResponse {
    id: String,
    result: Option<Value>,
    error: Option<RpcErrorPayload>,
}

#[derive(Debug, Clone)]
struct RpcErrorPayload {
    code: i64,
    message: String,
}

#[derive(Debug)]
enum BridgeError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Rpc { code: i64, message: String },
    ReaderDead,
    NotReady,
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "IO: {e}"),
            Self::Json(e) => write!(f, "JSON: {e}"),
            Self::Rpc { code, message } => write!(f, "RPC {code}: {message}"),
            Self::ReaderDead => write!(f, "reader dead"),
            Self::NotReady => write!(f, "not ready"),
        }
    }
}

impl From<std::io::Error> for BridgeError { fn from(e: std::io::Error) -> Self { Self::Io(e) } }
impl From<serde_json::Error> for BridgeError { fn from(e: serde_json::Error) -> Self { Self::Json(e) } }

type PendingMap = Arc<Mutex<HashMap<String, std::sync::mpsc::SyncSender<RpcResponse>>>>;

struct Bridge {
    stdin: ChildStdin,
    child: Child,
    pending: PendingMap,
    _reader: thread::JoinHandle<()>,
}

impl Bridge {
    fn new(python: &str, script: &str, timeout: Duration) -> Result<Self, BridgeError> {
        let mut child = Command::new(python)
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        let stdout = child.stdout.take().unwrap();
        let stdin  = child.stdin.take().unwrap();

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        // Register ready slot before spawning reader.
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<RpcResponse>(1);
        pending.lock().unwrap().insert("__ready__".to_string(), ready_tx);

        let pending_r = Arc::clone(&pending);
        let reader = thread::spawn(move || {
            let buf = BufReader::new(stdout);
            for line in buf.lines() {
                let line = match line { Ok(l) => l, Err(_) => break };
                let v: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => { eprintln!("[runner reader] bad JSON: {e}"); continue }
                };
                let resp = if v.get("ready") == Some(&Value::Bool(true)) {
                    RpcResponse { id: "__ready__".into(), result: None, error: None }
                } else {
                    let id = match v.get("id").and_then(Value::as_str) {
                        Some(s) => s.to_string(),
                        None => { eprintln!("[runner reader] no id in: {v}"); continue }
                    };
                    let error = v.get("error").and_then(|e| {
                        let code    = e.get("code").and_then(Value::as_i64).unwrap_or(-1);
                        let message = e.get("message").and_then(Value::as_str).unwrap_or("").to_string();
                        Some(RpcErrorPayload { code, message })
                    });
                    let result = v.get("result").cloned();
                    RpcResponse { id, result, error }
                };
                let mut map = pending_r.lock().unwrap();
                if let Some(tx) = map.remove(&resp.id) { let _ = tx.send(resp); }
            }
        });

        ready_rx.recv_timeout(timeout).map_err(|_| BridgeError::NotReady)?;
        Ok(Self { stdin, child, pending, _reader: reader })
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, BridgeError> {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = std::sync::mpsc::sync_channel::<RpcResponse>(1);
        self.pending.lock().unwrap().insert(id.clone(), tx);

        let line = format!(
            "{}\n",
            serde_json::json!({ "id": id, "method": method, "params": params })
        );
        self.stdin.write_all(line.as_bytes())?;

        let resp = rx.recv().map_err(|_| BridgeError::ReaderDead)?;
        if let Some(err) = resp.error {
            return Err(BridgeError::Rpc { code: err.code, message: err.message });
        }
        Ok(resp.result.unwrap_or(Value::Null))
    }

    /// Cloneable pending map — needed for concurrent tests.
    fn pending(&self) -> PendingMap { Arc::clone(&self.pending) }
    fn raw_stdin(&mut self) -> &mut ChildStdin { &mut self.stdin }

    fn close(mut self) -> Result<(), BridgeError> {
        drop(self.stdin);
        #[cfg(unix)] unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM); }
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        loop {
            match self.child.try_wait()? {
                Some(_) => return Ok(()),
                None if std::time::Instant::now() >= deadline => break,
                None => thread::sleep(Duration::from_millis(25)),
            }
        }
        self.child.kill()?;
        self.child.wait()?;
        Ok(())
    }
}

impl Drop for Bridge {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn resolve_python_and_script() -> (String, String) {
    let script = std::env::var("SIDECAR_SCRIPT")
        .unwrap_or_else(|_| {
            // Default: sibling test-child.py relative to this binary.
            let exe = std::env::current_exe().unwrap_or_default();
            exe.parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("../../test-child.py")
                .canonicalize()
                .unwrap_or_else(|_| std::path::PathBuf::from("test-child.py"))
                .to_string_lossy()
                .into_owned()
        });

    let python = std::env::var("PYTHON_PATH").unwrap_or_else(|_| {
        // Probe venv relative to the workspace.
        let cwd = std::env::current_dir().unwrap_or_default();
        #[cfg(unix)]   let venv = cwd.join("venv/bin/python");
        #[cfg(windows)] let venv = cwd.join("venv/Scripts/python.exe");
        if venv.exists() { venv.to_string_lossy().into_owned() } else { "python3".to_string() }
    });

    (python, script)
}

fn new_bridge() -> Bridge {
    let (python, script) = resolve_python_and_script();
    Bridge::new(&python, &script, Duration::from_secs(5))
        .expect("failed to start test-child.py")
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

fn test_echo() {
    print!("test_echo ... ");
    let mut b = new_bridge();
    let r = b.call("echo", serde_json::json!({"message": "hello"}))
              .expect("echo failed");
    assert_eq!(r["echo"], "hello", "unexpected: {r}");
    b.close().unwrap();
    println!("ok");
}

fn test_add() {
    print!("test_add ... ");
    let mut b = new_bridge();
    let r = b.call("add", serde_json::json!({"a": 40, "b": 2}))
              .expect("add failed");
    assert_eq!(r["sum"], 42, "unexpected: {r}");
    b.close().unwrap();
    println!("ok");
}

fn test_rpc_error() {
    print!("test_rpc_error ... ");
    let mut b = new_bridge();
    let err = b.call("raise_error", serde_json::json!({"message": "boom"}))
                .expect_err("expected an RPC error");
    match err {
        BridgeError::Rpc { message, .. } => assert!(message.contains("boom"), "msg: {message}"),
        other => panic!("wrong error variant: {other}"),
    }
    b.close().unwrap();
    println!("ok");
}

fn test_echo_b64() {
    print!("test_echo_b64 ... ");
    let mut b = new_bridge();
    let r = b.call("echo_b64", serde_json::json!({"data": "stitch"}))
              .expect("echo_b64 failed");
    let decoded = String::from_utf8(
        base64_decode(r["b64"].as_str().expect("no b64 field"))
    ).unwrap();
    assert_eq!(decoded, "stitch");
    b.close().unwrap();
    println!("ok");
}

fn test_slow() {
    print!("test_slow ... ");
    let mut b = new_bridge();
    let start = std::time::Instant::now();
    let r = b.call("slow", serde_json::json!({"seconds": 0.2}))
              .expect("slow failed");
    let elapsed = start.elapsed();
    assert!(elapsed >= Duration::from_millis(150), "too fast: {elapsed:?}");
    assert_eq!(r["slept"], 0.2_f64);
    b.close().unwrap();
    println!("ok");
}

fn test_unknown_method() {
    print!("test_unknown_method ... ");
    let mut b = new_bridge();
    let err = b.call("does_not_exist", serde_json::json!({}))
                .expect_err("expected RPC error for unknown method");
    match err {
        BridgeError::Rpc { code, .. } => assert_eq!(code, -32601),
        other => panic!("wrong error: {other}"),
    }
    b.close().unwrap();
    println!("ok");
}

fn test_concurrent() {
    print!("test_concurrent (4 threads × add) ... ");
    // We share a single bridge's pending map and stdin across threads.
    // Each thread writes a request and waits on its own channel.
    let (python, script) = resolve_python_and_script();
    let mut b = Bridge::new(&python, &script, Duration::from_secs(5)).unwrap();
    let pending = b.pending();

    // We need shared access to stdin.  Wrap it in Arc<Mutex<>>.
    // (For production use crossbeam-channel for multi-producer safety.)
    let stdin_arc: Arc<Mutex<&mut ChildStdin>> = {
        // Safety trick: we hold `b` alive for the whole scope, so the
        // reference is valid.  We transmute the lifetime for the Arc.
        // In production code you would restructure PythonBridge instead.
        let raw: *mut ChildStdin = b.raw_stdin() as *mut _;
        unsafe {
            Arc::new(Mutex::new(&mut *raw))
        }
    };

    let handles: Vec<_> = (0u32..4).map(|i| {
        let pending   = Arc::clone(&pending);
        let stdin_arc = Arc::clone(&stdin_arc);
        thread::spawn(move || -> u32 {
            let id = Uuid::new_v4().to_string();
            let (tx, rx) = std::sync::mpsc::sync_channel::<RpcResponse>(1);
            pending.lock().unwrap().insert(id.clone(), tx);

            let line = format!(
                "{}\n",
                serde_json::json!({"id": id, "method": "add", "params": {"a": i, "b": 10u32}})
            );
            stdin_arc.lock().unwrap().write_all(line.as_bytes()).unwrap();

            let resp = rx.recv().expect("recv failed");
            resp.result.unwrap()["sum"].as_u64().unwrap() as u32
        })
    }).collect();

    for (i, h) in handles.into_iter().enumerate() {
        let sum = h.join().expect("thread panicked");
        assert_eq!(sum, i as u32 + 10, "concurrent add mismatch at i={i}");
    }
    b.close().unwrap();
    println!("ok");
}

fn test_stdin_eof() {
    print!("test_stdin_eof ... ");
    // Drop the bridge immediately — stdin is closed, child should exit.
    let b = new_bridge();
    drop(b); // Drop triggers kill+wait via Drop impl.
    println!("ok");
}

// ---------------------------------------------------------------------------
// Simple base64 decoder (no external crate needed in the runner).
// ---------------------------------------------------------------------------

fn base64_decode(s: &str) -> Vec<u8> {
    // Use Python's base64 output which is standard alphabet.
    // Minimal implementation for test purposes only.
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [255u8; 256];
    for (i, &c) in alphabet.iter().enumerate() { table[c as usize] = i as u8; }

    let s: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        let a = table[chunk[0] as usize];
        let b = table[chunk[1] as usize];
        out.push((a << 2) | (b >> 4));
        if chunk.len() > 2 {
            let c = table[chunk[2] as usize];
            out.push((b << 4) | (c >> 2));
            if chunk.len() > 3 {
                let d = table[chunk[3] as usize];
                out.push((c << 6) | d);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    println!("=== Stitch Rust→Python test-runner ===\n");

    test_echo();
    test_add();
    test_rpc_error();
    test_echo_b64();
    test_slow();
    test_unknown_method();
    test_concurrent();
    test_stdin_eof();

    println!("\nAll tests passed.");
}
