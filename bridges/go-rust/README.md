# Stitch - Go → Rust

Spawn a Rust sidecar from Go and call any Rust function as a simple blocking
RPC call. Communication happens over newline-delimited JSON-RPC on stdin/stdout
— no network, no ports, no extra serialization library required on the Go side.

---

## How it works

```
Go process                              Rust child
──────────                              ──────────
NewRustBridge("./my-sidecar")  ──▶  ./my-sidecar
                                ◀──  {"ready":true}
b.Call("add", {"a":3,"b":4})   ──▶  {"id":"…","method":"add","params":{…}}
                                ◀──  {"id":"…","result":{"sum":7}}
b.Close()                       ──▶  stdin EOF → Rust loop exits cleanly
```

Every `Call` is multiplexed over a single stdin/stdout pipe. Concurrent calls
from multiple goroutines are fully supported — each request carries a UUID and
responses are routed back to the correct caller via an in-memory pending map.

---

## Prerequisites

| Requirement | Minimum version |
|---|---|
| Go | 1.21 |
| Rust (stable toolchain) | 1.70 |
| `cargo` | on `PATH` |

---

## Quick start

### 1. Add the Go dependency

```bash
go get github.com/stitch/go-rust
```

### 2. Write a Rust sidecar

Copy `template.sidecar/` as a starting point, then fill in the two template
slots:

```rust
// src/main.rs
use stitch_sidecar::run_sidecar;
use serde_json::Value;

fn main() {
    run_sidecar(|method, params| {
        match method {
            "__ping__" => Ok(serde_json::json!({ "pong": true })),
            "greet"    => handle_greet(params),
            _          => Err(format!("unknown method: {method}")),
        }
    });
}

fn handle_greet(params: Value) -> Result<Value, String> {
    let name = params["name"].as_str().ok_or("missing param: name")?;
    Ok(serde_json::json!({ "message": format!("Hello, {name}!") }))
}
```

Build it:

```bash
cd my-sidecar
cargo build --release
# binary: target/release/my-sidecar
```

### 3. Call it from Go

```go
package main

import (
    "encoding/json"
    "fmt"
    "log"

    gobridge "github.com/stitch/go-rust"
)

func main() {
    b, err := gobridge.NewRustBridge("./my-sidecar/target/release/my-sidecar")
    if err != nil {
        log.Fatal(err)
    }
    defer b.Close()

    // Health check
    if err := b.Ping(); err != nil {
        log.Fatal("ping:", err)
    }

    res, err := b.Call("greet", map[string]any{"name": "Alice"})
    if err != nil {
        log.Fatal(err)
    }

    var out struct{ Message string `json:"message"` }
    json.Unmarshal(res, &out)
    fmt.Println(out.Message) // Hello, Alice!
}
```

---

## File layout

```
bridges/go-rust/
├── template.client.go          # RustBridge Go client — copy into your project
├── go.mod                      # Go module: github.com/stitch/go-rust
├── edge-cases.md               # Go → Rust specific gotchas
├── template.sidecar/
│   ├── Cargo.toml              # Rename [package] name to match your binary
│   └── src/main.rs             # Fill in [CLAUDE_DISPATCH_CASES_HERE] and
│                               #         [CLAUDE_HANDLER_FUNCTIONS_HERE]
└── tests/
    ├── go.mod
    ├── go-rust_test.go         # Integration test suite
    └── test-child/
        ├── Cargo.toml
        └── src/main.rs         # Test sidecar: __ping__, echo, add,
                                #   raise_error, echo_b64, slow
```

---

## Template slots

The sidecar template in `template.sidecar/src/main.rs` contains two markers:

| Marker | Purpose |
|---|---|
| `// [CLAUDE_HANDLER_FUNCTIONS_HERE]` | Import your handler modules at the top of the file |
| `// [CLAUDE_DISPATCH_CASES_HERE]`    | Add `"method_name" => handle_fn(params),` arms to the match |

Both markers appear as comments so the file compiles as-is (with only the
built-in `__ping__` handler active).

---

## API reference

### `NewRustBridge(binaryPath string, args ...string) (*RustBridge, error)`

Spawns the Rust binary, waits for `{"ready":true}`, and starts the
response-dispatch goroutine. Returns an error if the binary is not found, the
process fails to start, or the sidecar does not emit `{"ready":true}` on
stdout.

### `(*RustBridge).Call(method string, params map[string]any) (json.RawMessage, error)`

Sends one JSON-RPC request and blocks until the response arrives. Thread-safe —
multiple goroutines may call `Call` concurrently.

Returns `(nil, *RpcError)` when the sidecar returns an error object.

### `(*RustBridge).CallContext(ctx context.Context, method string, params map[string]any) (json.RawMessage, error)`

Like `Call` but honours context cancellation and deadlines. If the context is
cancelled before the response arrives, the in-flight request ID is removed from
the pending map and `ctx.Err()` is returned. The sidecar continues processing
the request (there is no way to cancel work in progress inside the Rust
process).

### `(*RustBridge).Ping() error`

Sends a `__ping__` request and verifies the sidecar responds with
`{"pong":true}`. Times out after 5 seconds. Useful for health checks and
startup verification.

### `(*RustBridge).Close() error`

Closes stdin (triggers the Rust sidecar's stdin-EOF watchdog), waits up to 2 s
for a clean exit, then sends SIGKILL if the process is still running. Safe to
call more than once.

---

## Running the tests

```bash
cd bridges/go-rust/tests

# Option A: let the test suite build the Rust binary automatically
go test -v -count=1 ./...

# Option B: pre-build the Rust binary yourself
cd test-child && cargo build --release && cd ..
TEST_CHILD_BIN=./test-child/target/release/test-child go test -v -count=1 ./...
```

If `cargo` is not found on `PATH` the suite exits with code 0 and prints a
`SKIP` message so CI environments without Rust do not fail the overall build.

---

## Error handling

| Scenario | Behaviour |
|---|---|
| Method not registered in sidecar | `*RpcError` with `message: "unknown method: <name>"` |
| Handler returns `Err(msg)` | `*RpcError` with `message: msg` |
| Handler panics | Rust process aborts; all pending `Call()` return an error |
| Child process crashes | All pending `Call()` return `"child process exited"` error |
| Malformed JSON from child | Line is silently skipped (no matching pending call UUID) |
| Context cancelled | `ctx.Err()` returned; ID cleaned up from pending map |

---

## Concurrency notes

- **Go side**: a single `sync.Mutex` serialises writes to stdin; responses are
  demultiplexed by UUID into per-call buffered channels.
- **Rust side**: the `run_sidecar` loop is single-threaded — it processes one
  request at a time. Long-running handlers will block subsequent requests.
  For parallelism, spawn OS threads with `std::thread::spawn` inside your
  handler and collect results synchronously before returning.

---

## Windows notes

- The binary path must use `.exe` on Windows, or you can rely on `exec.Command`
  resolving names from PATH.
- `SIGTERM` is not available on Windows; `Close()` will still close stdin and
  wait, but the fallback path uses `Process.Kill()` rather than a signal.
- Cross-compile the Rust sidecar for Windows with:
  `cargo build --release --target x86_64-pc-windows-gnu`

---

## License

Part of the Stitch project. See the root `LICENSE` file.
