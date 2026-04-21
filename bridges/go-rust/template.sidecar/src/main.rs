// Stitch - Rust sidecar template for the Go → Rust bridge.
//
// Replace every [CLAUDE_*] placeholder with your real implementation.
//
// Protocol
// --------
//  1. On startup, write {"ready":true}\n to stdout (done by run_sidecar).
//  2. Read newline-delimited JSON requests from stdin.
//     Each request: {"id":"<uuid>","method":"<name>","params":{...}}
//  3. For every request write exactly one response line:
//     Success: {"id":"<uuid>","result":<value>}
//     Error:   {"id":"<uuid>","error":{"message":"<str>","traceback":"<str>"}}
//  4. When stdin reaches EOF, exit cleanly (handled by run_sidecar).
//  5. Use eprintln!() for all debug / log output — never write to stdout except
//     via the run_sidecar / send_response / send_error helpers.

use stitch_sidecar::run_sidecar;
use serde_json::Value;

// [CLAUDE_HANDLER_FUNCTIONS_HERE] - import your handler modules here, e.g.:
// mod handlers;

fn main() {
    // [CLAUDE_STATE] - initialise any shared state here, e.g. a DB pool or
    // an in-memory cache.  Pass it into the closure via a captured Arc<>.
    //
    // Example:
    //   let state = Arc::new(AppState::new());

    run_sidecar(|method, params| {
        match method {
            // __ping__ is always present so the Go client can health-check the
            // sidecar with RustBridge.Ping() at any time.
            "__ping__" => Ok(serde_json::json!({ "pong": true })),

            // [CLAUDE_DISPATCH_CASES_HERE] - add your method arms here, e.g.:
            // "add"     => handle_add(params),
            // "greet"   => handle_greet(params),
            // "process" => handle_process(params, Arc::clone(&state)),

            _ => Err(format!("unknown method: {method}")),
        }
    });
}

// [CLAUDE_HANDLER_FUNCTIONS_HERE] - implement one function per method below.
//
// Each handler receives the parsed params Value and returns either a
// serialisable result or an error string that is forwarded to the Go caller.
//
// Example:
//
// fn handle_add(params: Value) -> Result<Value, String> {
//     let a = params["a"].as_f64().ok_or("missing param: a")?;
//     let b = params["b"].as_f64().ok_or("missing param: b")?;
//     Ok(serde_json::json!({ "sum": a + b }))
// }
//
// fn handle_greet(params: Value) -> Result<Value, String> {
//     let name = params["name"]
//         .as_str()
//         .ok_or("missing param: name")?;
//     Ok(serde_json::json!({ "message": format!("Hello, {name}!") }))
// }
