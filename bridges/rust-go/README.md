# Stitch — Rust → Go

A production-ready template and integration-test suite for running a **Go binary
as a sidecar subprocess** driven by a **Rust client** over newline-delimited
JSON-RPC on stdio.

Part of the [Stitch](../../README.md) cross-language IPC project.

---

## Directory Layout

```
bridges/rust-go/
├── template.client/          # Rust client template
│   ├── Cargo.toml
│   └── src/
│       └── main.rs           # GoBridge struct + spawn_bridge() + demo main
│
├── template.sidecar/         # Go sidecar template
│   ├── go.mod
│   └── main.go               # Ready handshake, dispatch loop, TODO hooks
│
├── tests/
│   ├── test-child/           # Real Go sidecar with concrete method handlers
│   │   ├── go.mod
│   │   └── main.go           # echo, add, raise_error, echo_b64, slow
│   │
│   ├── test-runner/          # Standalone Rust binary that exercises test-child
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── main.rs
│   │
│   └── rust-go_test.rs       # #[cfg(test)] integration tests
│
├── edge-cases.md             # Known gotchas and mitigations
├── future-scope.md           # Ideas for evolving the bridge
└── README.md                 # This file
```

---

## Protocol

```
Child stdout (first line):  {"ready":true}
Rust → Go (request):        {"id":"<uuid4>","method":"<name>","params":<any>}\n
Go → Rust (success):        {"id":"<uuid4>","result":<any>}\n
Go → Rust (error):          {"id":"<uuid4>","error":{"code":<int>,"message":"<str>"}}\n
Rust closes stdin:          Go scanner.Scan() returns false → os.Exit(0)
```

All messages are a single JSON object per line (NDJSON).  Debug output goes to
stderr only — stdout is reserved for the protocol.

---

## Quick Start

### 1. Build the Go sidecar

```bash
cd template.sidecar
go build -o ../go-sidecar .
```

### 2. Build the Rust client

```bash
cd template.client
cargo build --release
```

### 3. Run

```bash
./template.client/target/release/go-bridge-client ./go-sidecar
```

The demo `main` calls `echo` and `add`, then shuts down cleanly.

---

## Using the Template

### Adding a method to the Go sidecar

Open `template.sidecar/main.go` and add a case to `dispatch`:

```go
case "greet":
    handleGreet(req)
```

Then implement the handler:

```go
type GreetParams struct {
    Name string `json:"name"`
}

func handleGreet(req *Request) {
    var p GreetParams
    if err := json.Unmarshal(req.Params, &p); err != nil {
        sendError(req.ID, -32602, fmt.Sprintf("invalid params: %v", err))
        return
    }
    sendSuccess(req.ID, map[string]interface{}{
        "greeting": "Hello, " + p.Name + "!",
    })
}
```

### Calling the method from Rust

```rust
let result = bridge.call("greet", serde_json::json!({"name": "world"}))?;
println!("{}", result["greeting"]);   // Hello, world!
```

### Calling with a timeout

```rust
use std::time::Duration;

let result = bridge.call_timeout(
    "slow_operation",
    serde_json::json!({"ms": 5000}),
    Duration::from_secs(10),
)?;
```

### Graceful shutdown

```rust
// Drops stdin → sends EOF to Go → Go calls os.Exit(0)
bridge.shutdown()?;
```

If you just drop the bridge without calling `shutdown`, the `Drop` impl sends
SIGKILL and reaps the zombie automatically.

---

## Running the Tests

### Integration test runner (human-readable output)

```bash
# Build the test-child sidecar first
cd tests/test-child && go build -o ../test-child-bin . && cd ../..

# Run the test runner
cargo run --manifest-path tests/test-runner/Cargo.toml -- tests/test-child-bin
```

### Cargo test suite

```bash
cd tests/test-child && go build -o test-child-bin . && cd ../..

TEST_CHILD_BIN=$(pwd)/tests/test-child/test-child-bin \
  cargo test --test rust-go_test
```

The `rust-go_test.rs` file uses `#[cfg(test)]` and is compiled as an
integration test target — add it to your `Cargo.toml` under `[[test]]` when
integrating into a workspace.

---

## Key Implementation Notes

### GoBridge struct

Located in `template.client/src/main.rs`.  Key fields:

| Field | Type | Purpose |
|---|---|---|
| `child` | `std::process::Child` | Handle to the spawned Go process |
| `stdin` | `ChildStdin` | Write requests here |
| `pending` | `Arc<Mutex<HashMap<String, SyncSender<RpcResponse>>>>` | Map UUID → waiting caller |

A dedicated reader thread owns the child's stdout and dispatches responses by
removing matching entries from `pending`.

### Ready handshake

`spawn_bridge()` blocks until the reader thread receives `{"ready":true}` or a
configurable timeout elapses (default 10 s).  The Go sidecar must write this as
its very first stdout line, before reading any input.

### bufio.Scanner buffer

The default Go scanner buffer is 64 KB.  The templates set it to 4 MB to
support large JSON payloads (e.g., base64-encoded binary data).  See
[edge-cases.md](./edge-cases.md#2-bufio-scanner-64-kb-default-limit) for
details.

---

## Dependencies

### Rust (template.client)

| Crate | Version | Purpose |
|---|---|---|
| `serde` | 1 | Derive macros for serialisation |
| `serde_json` | 1 | JSON encode/decode |
| `uuid` | 1 | v4 UUID request IDs |
| `ctrlc` | 3 | Cross-platform Ctrl-C handling |

### Go (template.sidecar / tests/test-child)

No external dependencies — only the Go standard library.  Minimum Go version:
**1.21**.

---

## Cross-Compilation

### Rust client for Linux on macOS

```bash
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
```

### Go sidecar for Linux on macOS

```bash
GOOS=linux GOARCH=amd64 go build -o sidecar-linux-amd64 .
```

Both binaries must target the same OS and architecture when deployed together.

---

## Further Reading

- [edge-cases.md](./edge-cases.md) — 10 specific pitfalls with mitigations
- [future-scope.md](./future-scope.md) — mmap IPC, CGo comparison, async Rust,
  protocol buffers, and more
