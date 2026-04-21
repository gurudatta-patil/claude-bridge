//! Stitch - shared Rust sidecar library.
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
//! stitch_sidecar = { path = "../../shared/rust_sidecar" }
//! serde_json = "1"
//! ```
//!
//! In your `main.rs`:
//! ```rust,no_run
//! use stitch_sidecar::run_sidecar;
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
// Streaming result type
// ─────────────────────────────────────────────────────────────────────────────

/// The return type for streaming-aware dispatch closures.
///
/// - `Single(v)` – send one normal result response.
/// - `Stream(iter)` – send each item as a chunk frame, then a terminal `{}`
///   result frame when the iterator is exhausted.
pub enum SidecarResult {
    Single(Value),
    Stream(Box<dyn Iterator<Item = Value>>),
}

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

/// Write `{"ready":true,"methods":[...]}\n` to stdout and flush.
/// Prefer this over `send_ready` when the full method list is available.
pub fn send_ready_with_methods(methods: &[&str]) {
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    writeln!(out, "{}", json!({"ready": true, "methods": methods}))
        .expect("write ready signal");
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

/// Write a streaming chunk frame `{"id":"…","chunk":…}` and flush.
pub fn send_chunk(out: &mut BufWriter<impl Write>, id: &str, chunk: Value) {
    let resp = json!({"id": id, "chunk": chunk});
    writeln!(out, "{resp}").expect("write chunk");
    out.flush().expect("flush chunk");
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug logging helper
// ─────────────────────────────────────────────────────────────────────────────

fn debug_log(v: Value) {
    eprintln!("{v}");
}

fn is_debug() -> bool {
    std::env::var("STITCH_DEBUG").as_deref() == Ok("1")
}

// ─────────────────────────────────────────────────────────────────────────────
// Main sidecar loop
// ─────────────────────────────────────────────────────────────────────────────

/// Run the complete JSON-RPC sidecar loop.
///
/// Sets up the ctrl-c handler, emits `{"ready":true}`, then reads
/// newline-delimited JSON requests from stdin.  Built-in methods are handled
/// before `dispatch` is called:
///
/// - `__ping__`  →  `{"pong":true,"pid":<pid>}`
///
/// Use [`run_sidecar_with_methods`] to also advertise method names in the
/// ready signal.
///
/// # Parameters
/// - `dispatch` - called with `(method: &str, params: Value)`.  Return
///   `Ok(Value)` for a success response or `Err(String)` for an error.
///
/// The function exits the process when stdin reaches EOF.
pub fn run_sidecar<F>(dispatch: F)
where
    F: Fn(&str, Value) -> Result<Value, String>,
{
    run_sidecar_with_methods(dispatch, &[]);
}

/// Like [`run_sidecar`], but also emits the supplied method names (plus
/// the built-in `__ping__`) in the ready signal so callers can discover the
/// API without a separate introspection call.
///
/// # Example
/// ```rust,no_run
/// use stitch_sidecar::run_sidecar_with_methods;
/// use serde_json::Value;
///
/// fn main() {
///     run_sidecar_with_methods(
///         |method, params| match method {
///             "echo" => Ok(params),
///             _ => Err(format!("unknown method: {method}")),
///         },
///         &["echo"],
///     );
/// }
/// ```
pub fn run_sidecar_with_methods<F>(dispatch: F, user_methods: &[&str])
where
    F: Fn(&str, Value) -> Result<Value, String>,
{
    // Install ctrl-c / SIGTERM handler.
    ctrlc::set_handler(|| {
        eprintln!("[sidecar] received ctrl-c / SIGTERM, exiting");
        std::process::exit(0);
    })
    .expect("failed to set ctrl-c handler");

    let debug = is_debug();

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    // Emit ready signal with full method list (built-ins + user methods).
    let mut all_methods: Vec<&str> = vec!["__ping__"];
    all_methods.extend_from_slice(user_methods);
    writeln!(out, "{}", json!({"ready": true, "methods": all_methods}))
        .expect("write ready");
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

        if debug {
            debug_log(json!({"dir": "→", "id": id_str, "method": method}));
        }

        // Handle built-ins before delegating to the user dispatch closure.
        let result: Result<Value, String> = match method.as_str() {
            "__ping__" => Ok(json!({"pong": true, "pid": std::process::id()})),
            _ => dispatch(&method, params),
        };

        match result {
            Ok(value) => {
                send_response(&mut out, id_str, value);
                if debug {
                    debug_log(json!({"dir": "←", "id": id_str, "ok": true}));
                }
            }
            Err(msg) => {
                send_error(&mut out, id_str, &msg, "");
                if debug {
                    debug_log(json!({"dir": "←", "id": id_str, "ok": false}));
                }
            }
        }
    }

    eprintln!("[sidecar] stdin closed, exiting");
    std::process::exit(0);
}

/// Like [`run_sidecar_with_methods`], but the dispatch closure returns
/// [`SidecarResult`] so handlers can opt into streaming chunk responses.
///
/// When the closure returns `SidecarResult::Stream(iter)`, each item from the
/// iterator is sent as `{"id":"…","chunk":…}`, followed by a terminal
/// `{"id":"…","result":{}}` to signal end-of-stream.
///
/// When the closure returns `SidecarResult::Single(v)`, behaviour is identical
/// to [`run_sidecar_with_methods`].
///
/// `run_sidecar` / `run_sidecar_with_methods` are left completely unchanged.
pub fn run_sidecar_streaming<F>(dispatch: F)
where
    F: Fn(&str, Value) -> Result<SidecarResult, String>,
{
    // Install ctrl-c / SIGTERM handler.
    ctrlc::set_handler(|| {
        eprintln!("[sidecar] received ctrl-c / SIGTERM, exiting");
        std::process::exit(0);
    })
    .expect("failed to set ctrl-c handler");

    let debug = is_debug();

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

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
        let traceparent = request.get("traceparent").and_then(Value::as_str).unwrap_or("").to_owned();

        if debug {
            let mut log = json!({"dir": "→", "id": id_str, "method": method});
            if !traceparent.is_empty() {
                log["traceparent"] = json!(traceparent);
            }
            debug_log(log);
        }

        let result: Result<SidecarResult, String> = match method.as_str() {
            "__ping__" => Ok(SidecarResult::Single(json!({"pong": true, "pid": std::process::id()}))),
            _ => dispatch(&method, params),
        };

        match result {
            Ok(SidecarResult::Single(value)) => {
                send_response(&mut out, id_str, value);
                if debug {
                    let mut log = json!({"dir": "←", "id": id_str, "ok": true});
                    if !traceparent.is_empty() {
                        log["traceparent"] = json!(traceparent);
                    }
                    debug_log(log);
                }
            }
            Ok(SidecarResult::Stream(iter)) => {
                for chunk in iter {
                    send_chunk(&mut out, id_str, chunk);
                }
                send_response(&mut out, id_str, json!({}));
                if debug {
                    let mut log = json!({"dir": "←", "id": id_str, "ok": true, "streamed": true});
                    if !traceparent.is_empty() {
                        log["traceparent"] = json!(traceparent);
                    }
                    debug_log(log);
                }
            }
            Err(msg) => {
                send_error(&mut out, id_str, &msg, "");
                if debug {
                    let mut log = json!({"dir": "←", "id": id_str, "ok": false});
                    if !traceparent.is_empty() {
                        log["traceparent"] = json!(traceparent);
                    }
                    debug_log(log);
                }
            }
        }
    }

    eprintln!("[sidecar] stdin closed, exiting");
    std::process::exit(0);
}
