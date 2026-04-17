use std::io::{self, BufRead, BufWriter, Write};
use std::thread;
use std::time::Duration;
use serde_json::{json, Value};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

fn main() {
    ctrlc::set_handler(|| {
        eprintln!("[test-child] ctrl-c received, exiting");
        std::process::exit(0);
    })
    .expect("failed to set ctrl-c handler");

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

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

        let line = line.trim().to_owned();
        if line.is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&line) {
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

fn dispatch(id: &Value, method: &str, params: &Value) -> Value {
    match method {
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

// ---------------------------------------------------------------------------
// echo — return the "text" param unchanged
// ---------------------------------------------------------------------------

fn handle_echo(id: &Value, params: &Value) -> Value {
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("");
    json!({ "id": id, "result": { "text": text } })
}

// ---------------------------------------------------------------------------
// add — sum two numbers (accepts integer or floating-point JSON numbers)
// ---------------------------------------------------------------------------

fn try_add(params: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let a = params
        .get("a")
        .and_then(Value::as_f64)
        .ok_or("missing or non-numeric param 'a'")?;
    let b = params
        .get("b")
        .and_then(Value::as_f64)
        .ok_or("missing or non-numeric param 'b'")?;
    Ok(json!({ "sum": a + b }))
}

fn handle_add(id: &Value, params: &Value) -> Value {
    match try_add(params) {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(e) => json!({
            "id": id,
            "error": { "message": e.to_string(), "traceback": format!("{e:?}") }
        }),
    }
}

// ---------------------------------------------------------------------------
// raise_error — always returns a JSON-RPC error (tests error bubbling)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// echo_b64 — base64-encode the "text" param and return it
// ---------------------------------------------------------------------------

fn handle_echo_b64(id: &Value, params: &Value) -> Value {
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("");
    let encoded = B64.encode(text.as_bytes());
    json!({ "id": id, "result": { "encoded": encoded } })
}

// ---------------------------------------------------------------------------
// slow — sleep for "ms" milliseconds, then echo "done"
// ---------------------------------------------------------------------------

fn try_slow(params: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let ms = params
        .get("ms")
        .and_then(Value::as_u64)
        .ok_or("missing or non-integer param 'ms'")?;
    thread::sleep(Duration::from_millis(ms));
    Ok(json!({ "done": true, "slept_ms": ms }))
}

fn handle_slow(id: &Value, params: &Value) -> Value {
    match try_slow(params) {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(e) => json!({
            "id": id,
            "error": { "message": e.to_string(), "traceback": format!("{e:?}") }
        }),
    }
}
