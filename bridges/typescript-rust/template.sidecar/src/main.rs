use stitch_sidecar::run_sidecar;
use serde_json::Value;

// [CLAUDE_IMPORT_HANDLERS] - import your handler modules here
// e.g. mod handlers;

fn main() {
    run_sidecar(|method, params| {
        match method {
            // [CLAUDE_ADD_METHODS] - add your method arms here, e.g.:
            // "my_method" => handle_my_method(params),
            _ => Err(format!("unknown method: {method}")),
        }
    });
}

// [CLAUDE_HANDLER_IMPLS] - implement your handlers below, e.g.:
//
// fn handle_my_method(params: Value) -> Result<Value, String> {
//     let input = params.get("input").and_then(Value::as_str).unwrap_or("");
//     Ok(serde_json::json!({ "output": input }))
// }
