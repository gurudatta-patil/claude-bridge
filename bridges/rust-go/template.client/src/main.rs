//! Ghost-Bridge: Rust client for a Go sidecar process communicating over JSON-RPC / stdio.
//!
//! Protocol:
//!   - Newline-delimited JSON (NDJSON)
//!   - Child writes `{"ready":true}` as its very first line before accepting any requests
//!   - Request  → `{"id":"<uuid>","method":"<name>","params":<any>}`
//!   - Success  → `{"id":"<uuid>","result":<any>}`
//!   - Error    → `{"id":"<uuid>","error":{"code":<i64>,"message":"<str>"}}`
//!   - stdin EOF signals the child to exit cleanly

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

// ─── GoBridge ────────────────────────────────────────────────────────────────

/// A live bridge to a spawned Go sidecar process.
pub struct GoBridge {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    pending: PendingMap,
    _reader: std::thread::JoinHandle<()>,
}

impl GoBridge {
    /// Spawn the Go binary at `path` with optional extra `args`.
    ///
    /// Blocks until the child emits `{"ready":true}` or `ready_timeout` elapses.
    pub fn spawn(path: &str, args: &[&str]) -> Result<Self, String> {
        Self::spawn_with_timeout(path, args, Duration::from_secs(10))
    }

    /// Same as [`spawn`] but with a configurable ready-handshake timeout.
    pub fn spawn_with_timeout(
        path: &str,
        args: &[&str],
        ready_timeout: Duration,
    ) -> Result<Self, String> {
        let mut child = Command::new(path)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("spawn failed: {e}"))?;

        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");

        let pending = new_pending_map();
        let (ready_tx, ready_rx) = sync_channel::<()>(1);
        let reader = spawn_reader_thread(stdout, pending.clone(), ready_tx);

        match ready_rx.recv_timeout(ready_timeout) {
            Ok(()) => {}
            Err(_) => return Err("child did not signal ready in time".to_string()),
        }

        Ok(Self { child, stdin, pending, _reader: reader })
    }

    /// Send a JSON-RPC call and block until the response arrives.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = Uuid::new_v4().to_string();
        let rx = register_call(&self.pending, &id);

        let req = serde_json::json!({"id": id, "method": method, "params": params});
        let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        match rx.recv() {
            Ok(resp) => {
                if let Some(err) = resp.error {
                    Err(err.message)
                } else {
                    Ok(resp.result.unwrap_or(Value::Null))
                }
            }
            Err(_) => Err("response channel closed (child may have died)".to_string()),
        }
    }

    /// Call with a timeout.
    pub fn call_timeout(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = Uuid::new_v4().to_string();
        let rx = register_call(&self.pending, &id);

        let req = serde_json::json!({"id": id, "method": method, "params": params});
        let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        match rx.recv_timeout(timeout) {
            Ok(resp) => {
                if let Some(err) = resp.error {
                    Err(err.message)
                } else {
                    Ok(resp.result.unwrap_or(Value::Null))
                }
            }
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err("response channel closed (child may have died or timed out)".to_string())
            }
        }
    }

    /// Gracefully shut down: drop stdin (causes EOF in child), then wait.
    pub fn shutdown(mut self) -> std::io::Result<std::process::ExitStatus> {
        drop(self.stdin);
        self.child.wait()
    }
}

impl Drop for GoBridge {
    fn drop(&mut self) {
        kill_child(&mut self.child);
    }
}

/// Install a Ctrl-C handler that prints a message and exits.
pub fn install_ctrlc_handler() {
    ctrlc::set_handler(move || {
        eprintln!("\n[GoBridge] Ctrl-C received — exiting.");
        std::process::exit(0);
    })
    .expect("failed to install Ctrl-C handler");
}

// ─── Demo main ───────────────────────────────────────────────────────────────

fn main() {
    install_ctrlc_handler();

    let sidecar_path =
        std::env::args().nth(1).unwrap_or_else(|| "./go-sidecar".to_string());

    println!("[main] Spawning Go sidecar: {sidecar_path}");

    let mut bridge =
        GoBridge::spawn(&sidecar_path, &[]).unwrap_or_else(|e| {
            eprintln!("[main] Failed to spawn bridge: {e}");
            std::process::exit(1);
        });

    println!("[main] Bridge ready.");

    match bridge.call("echo", serde_json::json!({"text": "Hello from Rust!"})) {
        Ok(result) => println!("[main] echo result: {result}"),
        Err(e) => eprintln!("[main] echo error: {e}"),
    }

    match bridge.shutdown() {
        Ok(status) => println!("[main] Child exited: {status}"),
        Err(e) => eprintln!("[main] Shutdown error: {e}"),
    }
}
