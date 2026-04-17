//! Ghost-Bridge — shared Rust sidecar library.
//!
//! All Rust sidecars (typescript-rust, python-rust) use this crate instead
//! of duplicating the BufWriter setup, ctrl-c handler, ready signal, and
//! stdin dispatch loop.
//!
//! # Usage
//!
//! In your `Cargo.toml`:
//! ```toml
//! [dependencies]
//! ghost_bridge_sidecar = { path = "../../shared/rust_sidecar" }
//! serde_json = "1"
//! ```
//!
//! In your `main.rs`:
//! ```rust,no_run
//! use ghost_bridge_sidecar::run_sidecar;
//! use serde_json::Value;
//!
//! fn main() {
//!     run_sidecar(|method, params| match method {
//!         "echo" => Ok(params),
//!         _ => Err(format!("unknown method: {method}")),
//!     });
//! }
//! ```

use std::io::{self, BufRead, BufWriter, Write};

use serde_json::{json, Value};

// ─────────────────────────────────────────────────────────────────────────────
// Ready signal
// ─────────────────────────────────────────────────────────────────────────────

/// Write `{"ready":true}\n` to stdout and flush.
/// Call this exactly once before entering the request loop.
pub fn send_ready() {
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    writeln!(out, "{}", json!({"ready": true})).expect("write ready signal");
    out.flush().expect("flush ready signal");
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-response writers
// ─────────────────────────────────────────────────────────────────────────────

/// Write a success response `{"id":"…","result":…}` and flush.
pub fn send_response(out: &mut BufWriter<impl Write>, id: &str, result: Value) {
    let resp = json!({"id": id, "result": result});
    writeln!(out, "{resp}").expect("write response");
    out.flush().expect("flush response");
}

/// Write an error response `{"id":"…","error":{"message":"…","traceback":"…"}}` and flush.
pub fn send_error(out: &mut BufWriter<impl Write>, id: &str, message: &str, traceback: &str) {
    let resp = json!({
        "id": id,
        "error": {
            "message": message,
            "traceback": traceback
        }
    });
    writeln!(out, "{resp}").expect("write error response");
    out.flush().expect("flush error response");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main sidecar loop
// ─────────────────────────────────────────────────────────────────────────────

/// Run the complete JSON-RPC sidecar loop.
///
/// Sets up the ctrl-c handler, emits the ready signal, then reads
/// newline-delimited JSON requests from stdin, calls `dispatch` for each, and
/// writes the response.
///
/// # Parameters
/// - `dispatch` — called with `(method: &str, params: Value)`.  Return
///   `Ok(Value)` for a success response or `Err(String)` for an error.
///
/// The function returns when stdin reaches EOF.
pub fn run_sidecar<F>(dispatch: F)
where
    F: Fn(&str, Value) -> Result<Value, String>,
{
    // Install ctrl-c / SIGTERM handler.
    ctrlc::set_handler(|| {
        eprintln!("[sidecar] received ctrl-c / SIGTERM, exiting");
        std::process::exit(0);
    })
    .expect("failed to set ctrl-c handler");

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    // Emit ready signal — parent blocks until it reads this.
    writeln!(out, "{}", json!({"ready": true})).expect("write ready");
    out.flush().expect("flush ready");

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[sidecar] stdin read error: {e}");
                break;
            }
        };

        let trimmed = line.trim().to_owned();
        if trimmed.is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&trimmed) {
            Ok(v) => v,
            Err(e) => {
                let resp = json!({
                    "id": null,
                    "error": {
                        "message": format!("JSON parse error: {e}"),
                        "traceback": format!("{e:?}")
                    }
                });
                writeln!(out, "{resp}").ok();
                out.flush().ok();
                continue;
            }
        };

        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let id_str = id.as_str().unwrap_or("null");
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let params = request
            .get("params")
            .cloned()
            .unwrap_or_else(|| json!({}));

        match dispatch(&method, params) {
            Ok(result) => {
                send_response(&mut out, id_str, result);
            }
            Err(msg) => {
                send_error(&mut out, id_str, &msg, "");
            }
        }
    }

    eprintln!("[sidecar] stdin closed, exiting");
}
