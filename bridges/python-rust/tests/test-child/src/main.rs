// Ghost-Bridge — test-child Rust sidecar
//
// Implements the following methods for the Python test suite:
//
//   echo        {"msg": str}              -> str
//   add         {"a": i64, "b": i64}      -> i64
//   raise_error {"code": i32, "msg": str} -> error
//   echo_b64    {"data": base64_str}      -> base64_str  (round-trips raw bytes)
//   slow        {"ms": u64}               -> "done"      (sleeps then responds)

use std::io::{self, BufRead, BufWriter, Write};
use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct SuccessResponse<'a, T: Serialize> {
    id: &'a str,
    result: T,
}

#[derive(Debug, Serialize)]
struct ErrorResponse<'a> {
    id: &'a str,
    error: RpcError,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

// ---------------------------------------------------------------------------
// Low-level I/O helpers
// ---------------------------------------------------------------------------

fn write_ready(out: &mut impl Write) -> io::Result<()> {
    writeln!(out, "{{\"ready\":true}}")?;
    out.flush()
}

fn write_success(out: &mut impl Write, id: &str, result: impl Serialize) -> io::Result<()> {
    let response = SuccessResponse { id, result };
    let line = serde_json::to_string(&response)
        .unwrap_or_else(|e| {
            format!(
                "{{\"id\":\"{id}\",\"error\":{{\"code\":-32603,\"message\":\"{e}\"}}}}",
            )
        });
    writeln!(out, "{}", line)?;
    out.flush()
}

fn write_error(out: &mut impl Write, id: &str, code: i32, message: impl Into<String>) -> io::Result<()> {
    let response = ErrorResponse {
        id,
        error: RpcError {
            code,
            message: message.into(),
        },
    };
    let line = serde_json::to_string(&response).unwrap_or_else(|_| {
        format!(
            "{{\"id\":\"{id}\",\"error\":{{\"code\":-32603,\"message\":\"serialization error\"}}}}",
        )
    });
    writeln!(out, "{}", line)?;
    out.flush()
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn handle_echo(out: &mut impl Write, req: &Request) -> io::Result<()> {
    let msg = match req.params["msg"].as_str() {
        Some(s) => s.to_owned(),
        None => return write_error(out, &req.id, -32602, "missing param: msg"),
    };
    write_success(out, &req.id, msg)
}

fn handle_add(out: &mut impl Write, req: &Request) -> io::Result<()> {
    let a = match req.params["a"].as_i64() {
        Some(v) => v,
        None => return write_error(out, &req.id, -32602, "missing or invalid param: a"),
    };
    let b = match req.params["b"].as_i64() {
        Some(v) => v,
        None => return write_error(out, &req.id, -32602, "missing or invalid param: b"),
    };
    write_success(out, &req.id, a + b)
}

fn handle_raise_error(out: &mut impl Write, req: &Request) -> io::Result<()> {
    let code = req.params["code"].as_i64().unwrap_or(-1) as i32;
    let msg = req.params["msg"]
        .as_str()
        .unwrap_or("intentional error")
        .to_owned();
    write_error(out, &req.id, code, msg)
}

fn handle_echo_b64(out: &mut impl Write, req: &Request) -> io::Result<()> {
    let data = match req.params["data"].as_str() {
        Some(s) => s,
        None => return write_error(out, &req.id, -32602, "missing param: data"),
    };
    // Validate that it is actually base64 (decode then re-encode for a clean round-trip).
    let decoded = match B64.decode(data) {
        Ok(bytes) => bytes,
        Err(e) => return write_error(out, &req.id, -32602, format!("invalid base64: {e}")),
    };
    let re_encoded = B64.encode(&decoded);
    write_success(out, &req.id, re_encoded)
}

fn handle_slow(out: &mut impl Write, req: &Request) -> io::Result<()> {
    let ms = req.params["ms"].as_u64().unwrap_or(100);
    thread::sleep(Duration::from_millis(ms));
    write_success(out, &req.id, "done")
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

fn dispatch(out: &mut impl Write, req: &Request) -> io::Result<()> {
    match req.method.as_str() {
        "echo" => handle_echo(out, req),
        "add" => handle_add(out, req),
        "raise_error" => handle_raise_error(out, req),
        "echo_b64" => handle_echo_b64(out, req),
        "slow" => handle_slow(out, req),
        _ => write_error(
            out,
            &req.id,
            -32601,
            format!("method not found: {}", req.method),
        ),
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    ctrlc::set_handler(move || {
        eprintln!("test-child: caught signal — exiting.");
        std::process::exit(0);
    })
    .expect("failed to set signal handler");

    write_ready(&mut out).expect("failed to write ready signal");

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("test-child: stdin error: {e}");
                break;
            }
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: Request = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let _ = write_error(&mut out, "null", -32700, format!("parse error: {e}"));
                continue;
            }
        };

        eprintln!(
            "test-child: dispatch method={} id={}",
            req.method, req.id
        );

        if let Err(e) = dispatch(&mut out, &req) {
            eprintln!("test-child: write error: {e}");
            break;
        }
    }

    eprintln!("test-child: stdin EOF — exiting.");
}
