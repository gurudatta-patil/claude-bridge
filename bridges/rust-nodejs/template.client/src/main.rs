//! Stitch - Rust client template for a Node.js sidecar.
//!
//! Replace every `[CLAUDE_*]` placeholder before use:
//!   [CLAUDE_SIDECAR_PATH]  - absolute or relative path to the .js sidecar
//!   [CLAUDE_METHOD]        - JSON-RPC method name for the demo call
//!   [CLAUDE_PARAMS]        - serde_json::Value for the demo call's params
//!
//! Protocol (newline-delimited JSON over stdio):
//!   - Child writes `{"ready":true}` as its very first line.
//!   - Every request: `{"id":"<uuid>","method":"...","params":{...}}`
//!   - Success reply: `{"id":"...","result":{...}}`
//!   - Error reply:   `{"id":"...","error":{"code":...,"message":"..."}}`
//!   - Closing stdin causes the Node.js sidecar to exit cleanly.

mod bridge_client;
use bridge_client::*;

use std::{
    io::{BufWriter, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::sync_channel,
    time::Duration,
};

use serde_json::Value;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// [CLAUDE_HANDLER_STRUCTS_HERE]
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// NodeBridge
// ---------------------------------------------------------------------------

pub struct NodeBridge {
    child: Child,
    stdin_writer: Option<BufWriter<ChildStdin>>,
    pending: PendingMap,
    _reader: std::thread::JoinHandle<()>,
}

impl NodeBridge {
    /// Spawn the Node.js sidecar at `sidecar_path` and wait for its
    /// `{"ready":true}` handshake.
    pub fn spawn(sidecar_path: &str, ready_timeout: Duration) -> Result<Self, String> {
        let mut child = Command::new("node")
            .arg(sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to spawn node: {e}"))?;

        let stdout = child.stdout.take().expect("stdout not captured");
        let stdin = child.stdin.take().expect("stdin not captured");
        let stdin_writer = BufWriter::new(stdin);

        let pending = new_pending_map();
        let (ready_tx, ready_rx) = sync_channel::<()>(1);
        let reader = spawn_reader_thread(stdout, pending.clone(), ready_tx);

        match ready_rx.recv_timeout(ready_timeout) {
            Ok(()) => {}
            Err(_) => return Err("sidecar did not send {\"ready\":true} in time".into()),
        }

        Ok(NodeBridge {
            child,
            stdin_writer: Some(stdin_writer),
            pending,
            _reader: reader,
        })
    }

    /// Send a JSON-RPC request and block until a response arrives or `timeout`
    /// elapses.
    pub fn call(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = Uuid::new_v4().to_string();
        let rx = register_call(&self.pending, &id);

        let req = serde_json::json!({"id": id, "method": method, "params": params});
        let line = serde_json::to_string(&req).expect("serialisation is infallible");

        {
            let writer = self
                .stdin_writer
                .as_mut()
                .ok_or_else(|| "bridge is closed".to_string())?;
            writeln!(writer, "{line}").map_err(|e| format!("write error: {e}"))?;
            writer.flush().map_err(|e| format!("flush error: {e}"))?;
        }

        match rx.recv_timeout(timeout) {
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("timeout waiting for response to id={id}"))
            }
            Ok(resp) => {
                if let Some(err) = resp.error {
                    Err(err.message)
                } else {
                    Ok(resp.result.unwrap_or(Value::Null))
                }
            }
        }
    }

    /// Close stdin, which signals EOF to the Node.js sidecar and causes it
    /// to exit.
    pub fn close(&mut self) {
        drop(self.stdin_writer.take());
    }
}

impl Drop for NodeBridge {
    fn drop(&mut self) {
        self.close();
        kill_child(&mut self.child);
    }
}

// ---------------------------------------------------------------------------
// Demo main  (replace placeholders before use)
// ---------------------------------------------------------------------------

fn main() {
    ctrlc::set_handler(|| {
        eprintln!("[client] Ctrl-C received, shutting down");
        std::process::exit(0);
    })
    .expect("failed to install Ctrl-C handler");

    let sidecar_path = "[CLAUDE_SIDECAR_PATH]";

    let mut bridge =
        NodeBridge::spawn(sidecar_path, Duration::from_secs(5)).expect("bridge spawn failed");

    eprintln!("[client] Node.js sidecar ready");

    // [CLAUDE_DISPATCH_CASES_HERE]

    let method = "[CLAUDE_METHOD]";
    let params: Value =
        serde_json::from_str("[CLAUDE_PARAMS]").expect("invalid CLAUDE_PARAMS JSON");

    match bridge.call(method, params, Duration::from_secs(10)) {
        Ok(result) => println!("result: {result}"),
        Err(err) => eprintln!("error: {err}"),
    }

    bridge.close();
    eprintln!("[client] done");
}
