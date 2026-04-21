// test-child - integration test sidecar for the Go → Rust bridge.
//
// Implements: __ping__, echo, add, raise_error, echo_b64, slow.
// This binary is spawned by go-rust_test.go during `go test`.
//
// Build:
//   cd tests/test-child && cargo build --release
//   Binary: tests/test-child/target/release/test-child
//
// The binary is also built automatically by go-rust_test.go's TestMain when
// the TEST_CHILD_BIN env var is not set and `cargo` is available on PATH.

use std::io::{self, BufRead, BufWriter, Write};
use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};

fn main() {
    // Install ctrl-c / SIGTERM handler so the sidecar exits cleanly when the
    // parent is killed rather than waiting for stdin EOF.
    ctrlc::set_handler(|| {
        eprintln!("[test-child] received ctrl-c / SIGTERM, exiting");
        std::process::exit(0);
    })
    .expect("failed to set ctrl-c handler");

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    // Emit the ready signal - the Go parent blocks until it reads this line.
    writeln!(out, "{}", json!({"ready": true})).expect("write ready");
    out.flush().expect("flush ready");

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[test-child] stdin read error: {e}");
                break;
            }
        };

        let trimmed = line.trim().to_owned();
        if trimmed.is_empty() {
            continue;
        }

        // Parse the incoming JSON-RPC request.
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
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let params = request
            .get("params")
            .cloned()
            .unwrap_or_else(|| json!({}));

        let response = dispatch(&id, &method, &params);
        writeln!(out, "{response}").expect("write response");
        out.flush().expect("flush response");
    }

    eprintln!("[test-child] stdin closed, exiting");
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

fn dispatch(id: &Value, method: &str, params: &Value) -> Value {
    match method {
        "__ping__" => json!({ "id": id, "result": { "pong": true } }),
        "echo" => handle_echo(id, params),
        "add" => handle_add(id, params),
        "raise_error" => handle_raise_error(id, params),
        "echo_b64" => handle_echo_b64(id, params),
        "slow" => handle_slow(id, params),
        _ => json!({
            "id": id,
            "error": {
                "message": format!("unknown method: {method}"),
                "traceback": format!("UnknownMethod({method:?})")
            }
        }),
    }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// echo - return the params object unchanged.
fn handle_echo(id: &Value, params: &Value) -> Value {
    json!({ "id": id, "result": params })
}

/// add - sum two JSON numbers (integer or floating-point).
///
/// Go sends all JSON numbers as float64; Rust accepts them via as_f64().
/// The sum is returned as a JSON number which Go will decode into float64.
fn try_add(params: &Value) -> Result<Value, String> {
    let a = params
        .get("a")
        .and_then(Value::as_f64)
        .ok_or_else(|| "missing or non-numeric param 'a'".to_owned())?;
    let b = params
        .get("b")
        .and_then(Value::as_f64)
        .ok_or_else(|| "missing or non-numeric param 'b'".to_owned())?;
    Ok(json!({ "sum": a + b }))
}

fn handle_add(id: &Value, params: &Value) -> Value {
    match try_add(params) {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(msg) => json!({
            "id": id,
            "error": { "message": msg, "traceback": "" }
        }),
    }
}

/// raise_error - always returns a JSON-RPC error (tests error propagation).
fn handle_raise_error(id: &Value, params: &Value) -> Value {
    let msg = params
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("deliberate test error");
    json!({
        "id": id,
        "error": {
            "message": msg,
            "traceback": format!("RaisedError({msg:?})")
        }
    })
}

/// echo_b64 - base64-encode the "data" string and return it.
///
/// Used by TestLargePayload to exercise the scanner's enlarged buffer.
fn handle_echo_b64(id: &Value, params: &Value) -> Value {
    let data = match params.get("data").and_then(Value::as_str) {
        Some(s) => s,
        None => {
            return json!({
                "id": id,
                "error": { "message": "missing string param 'data'", "traceback": "" }
            })
        }
    };
    let encoded = B64.encode(data.as_bytes());
    json!({ "id": id, "result": { "data": encoded } })
}

/// slow - sleep for "ms" milliseconds, then return {"slept_ms": <n>}.
///
/// Used by TestConcurrent to verify that multiple goroutines can call the
/// bridge without serialisation delays.
fn try_slow(params: &Value) -> Result<Value, String> {
    let ms = params
        .get("ms")
        .and_then(Value::as_u64)
        .ok_or_else(|| "missing or non-integer param 'ms'".to_owned())?;
    thread::sleep(Duration::from_millis(ms));
    Ok(json!({ "slept_ms": ms }))
}

fn handle_slow(id: &Value, params: &Value) -> Value {
    match try_slow(params) {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(msg) => json!({
            "id": id,
            "error": { "message": msg, "traceback": "" }
        }),
    }
}
