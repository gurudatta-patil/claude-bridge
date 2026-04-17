//! Stitch — Rust client template for the Python sidecar.
//!
//! Replace every `TODO` comment with your own logic before shipping.
//!
//! # Protocol
//! Child writes `{"ready":true}\n` on startup.
//! Every request:  `{"id":"<uuid>","method":"<name>","params":{...}}\n`
//! Success reply:  `{"id":"<uuid>","result":<any>}\n`
//! Error reply:    `{"id":"<uuid>","error":{"code":<i64>,"message":"<str>"}}\n`
//! stdin EOF → sidecar exits cleanly.

mod bridge_client;
use bridge_client::*;

use std::{
    io::Write,
    process::{Command, Stdio},
    sync::mpsc::sync_channel,
    time::Duration,
};

use serde_json::Value;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// PythonBridge
// ---------------------------------------------------------------------------

pub struct PythonBridge {
    stdin: std::process::ChildStdin,
    child: std::process::Child,
    pending: PendingMap,
    /// Kept alive so the reader thread lives as long as the bridge.
    _reader: std::thread::JoinHandle<()>,
}

impl PythonBridge {
    /// Spawn the Python sidecar and wait for its `{"ready":true}` signal.
    ///
    /// * `python_path`   — path to the Python interpreter.
    /// * `script_path`   — path to the `.py` sidecar file.
    /// * `ready_timeout` — deadline for the ready handshake.
    pub fn new(
        python_path: &str,
        script_path: &str,
        ready_timeout: Duration,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut child = Command::new(python_path)
            .arg(script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        let stdout = child.stdout.take().expect("stdout piped but missing");
        let stdin = child.stdin.take().expect("stdin piped but missing");

        let pending = new_pending_map();

        let (ready_tx, ready_rx) = sync_channel::<()>(1);
        let reader = spawn_reader_thread(stdout, pending.clone(), ready_tx);

        ready_rx
            .recv_timeout(ready_timeout)
            .map_err(|_| "sidecar did not send ready signal in time")?;

        Ok(Self { stdin, child, pending, _reader: reader })
    }

    /// Invoke a remote method and block until the reply arrives.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = Uuid::new_v4().to_string();
        let rx = register_call(&self.pending, &id);

        let req = serde_json::json!({"id": id, "method": method, "params": params});
        let mut line = serde_json::to_string(&req).unwrap();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        let resp = rx.recv().map_err(|_| "reader thread died".to_string())?;

        if let Some(err) = resp.error {
            return Err(err.message);
        }
        Ok(resp.result.unwrap_or(Value::Null))
    }

    /// Graceful shutdown: close stdin (EOF → sidecar exits), then wait.
    pub fn close(mut self) -> Result<(), String> {
        drop(self.stdin);
        self.child.wait().map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl Drop for PythonBridge {
    fn drop(&mut self) {
        kill_child(&mut self.child);
    }
}

// ---------------------------------------------------------------------------
// main — wire Ctrl-C, run a demo call
// ---------------------------------------------------------------------------

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let script_path = std::env::var("SIDECAR_SCRIPT")
        .unwrap_or_else(|_| "sidecar.py".to_string());

    let python_path = std::env::var("PYTHON_PATH").unwrap_or_else(|_| {
        let cwd = std::env::current_dir().unwrap_or_default();
        #[cfg(unix)]
        let venv = cwd.join("venv/bin/python");
        #[cfg(windows)]
        let venv = cwd.join("venv/Scripts/python.exe");
        if venv.exists() {
            venv.to_string_lossy().into_owned()
        } else {
            "python3".to_string()
        }
    });

    ctrlc::set_handler(move || {
        eprintln!("[main] Ctrl-C — shutting down.");
        std::process::exit(0);
    })?;

    let mut bridge = PythonBridge::new(&python_path, &script_path, Duration::from_secs(5))?;
    println!("[main] Bridge ready.");

    // TODO: replace with your own method calls.
    let result = bridge.call("echo", serde_json::json!({ "message": "hello from Rust" }))?;
    println!("[main] echo result: {result}");

    bridge.close()?;
    println!("[main] Bridge closed.");
    Ok(())
}
