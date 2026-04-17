// Ghost-Bridge — Rust sidecar template
//
// Replace every [CLAUDE_*] placeholder with your real implementation.
//
// Protocol
// --------
//  1. On startup, write {"ready":true}\n to stdout.
//  2. Read newline-delimited JSON requests from stdin.
//     Each request: {"id":"<uuid>","method":"<name>","params":{...}}
//  3. For every request write exactly one response line:
//     Success: {"id":"<uuid>","result":<value>}
//     Error:   {"id":"<uuid>","error":{"message":"<str>","traceback":"<str>"}}
//  4. When stdin reaches EOF, exit cleanly.
//  5. Use eprintln!() for all debug / log output.

use ghost_bridge_sidecar::run_sidecar;
use serde_json::Value;

// ---------------------------------------------------------------------------
// [CLAUDE_STATE] — add any shared state here (e.g. database handles, caches)
// ---------------------------------------------------------------------------
// struct AppState {
//     counter: std::sync::atomic::AtomicU64,
// }

fn main() {
    // [CLAUDE_STATE] initialise shared state here if needed.

    run_sidecar(|method, params| {
        match method {
            // [CLAUDE_DISPATCH] — add your method arms here.
            // Example:
            //   "add" => handle_add(params),
            //   "echo" => Ok(params),
            _ => Err(format!("Method not found: {method}")),
        }
    });
}

// ---------------------------------------------------------------------------
// [CLAUDE_HANDLERS] — implement one function per method
// ---------------------------------------------------------------------------
//
// fn handle_add(params: Value) -> Result<Value, String> {
//     let a = params["a"].as_i64().ok_or("missing param: a")?;
//     let b = params["b"].as_i64().ok_or("missing param: b")?;
//     Ok(serde_json::json!(a + b))
// }
