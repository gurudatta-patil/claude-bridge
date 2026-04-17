# Stitch — Rust → Python

Seamless cross-language IPC between a Rust host process and a Python sidecar
via newline-delimited JSON-RPC over stdio.

---

## Directory layout

```
bridges/rust-python/
├── template.client/          # Rust client library template
│   ├── Cargo.toml
│   └── src/main.rs           # PythonBridge struct (new / call / close / Drop)
├── template.sidecar.py       # Python sidecar template (replace TODOs)
├── tests/
│   ├── test-child.py         # Real Python sidecar: echo, add, raise_error,
│   │                         #   echo_b64, slow
│   ├── rust-python_test.rs   # Rust #[cfg(test)] integration tests
│   └── test-runner/          # Standalone binary that exercises all methods
│       ├── Cargo.toml
│       └── src/main.rs
├── edge-cases.md             # Rust→Python-specific gotchas
├── future-scope.md           # Roadmap ideas
└── README.md                 # This file
```

---

## Protocol

| Direction     | Message                                                  |
|---------------|----------------------------------------------------------|
| Child → Host  | `{"ready":true}` — first line on startup                 |
| Host → Child  | `{"id":"<uuid>","method":"<name>","params":{...}}`       |
| Child → Host  | `{"id":"<uuid>","result":<any>}` — success               |
| Child → Host  | `{"id":"<uuid>","error":{"code":<int>,"message":"..."}}` |
| Host → Child  | stdin EOF — signals the child to exit                    |

All messages are newline-delimited (`\n`).

---

## Quick start

### 1. Build and run the test-runner

```bash
# From the repo root:
cd bridges/rust-python/tests/test-runner

# Optional: point at a specific interpreter
export PYTHON_PATH=/usr/bin/python3
export SIDECAR_SCRIPT=../test-child.py

cargo run
```

Expected output:

```
=== Stitch Rust→Python test-runner ===

test_echo ... ok
test_add ... ok
test_rpc_error ... ok
test_echo_b64 ... ok
test_slow ... ok
test_unknown_method ... ok
test_concurrent (4 threads × add) ... ok
test_stdin_eof ... ok

All tests passed.
```

### 2. Run `#[test]` integration tests

```bash
cd bridges/rust-python/tests/test-runner
export SIDECAR_SCRIPT=../test-child.py
cargo test --test rust-python_test   # if wired into a workspace
# or add the test file to the crate's [[test]] table in Cargo.toml
```

---

## Using the template

### Python sidecar (`template.sidecar.py`)

1. Copy `template.sidecar.py` to your project.
2. Add your handler functions to `_HANDLERS`.
3. The `sys.stdout = sys.stderr` redirect at the top is mandatory — do not
   remove it.

### Rust client (`template.client/`)

1. Copy `template.client/` into your workspace.
2. Set `SIDECAR_SCRIPT` and `PYTHON_PATH` at runtime, or hardcode them using
   `std::env::current_dir()` / `std::env::var()`.
3. Use `PythonBridge::new()` / `call()` / `close()`.

```rust
let mut bridge = PythonBridge::new(
    "venv/bin/python",          // interpreter
    "my_sidecar.py",            // script
    Duration::from_secs(5),     // ready timeout
)?;

let result = bridge.call("my_method", serde_json::json!({"key": "value"}))?;
bridge.close()?;
```

---

## Environment variables

| Variable        | Default                          | Description                        |
|-----------------|----------------------------------|------------------------------------|
| `PYTHON_PATH`   | `venv/bin/python` or `python3`   | Path to the Python interpreter     |
| `SIDECAR_SCRIPT`| `sidecar.py`                     | Path to the `.py` sidecar file     |

Build paths with `std::env::current_dir()` or `std::env::var()` — never
hardcode absolute paths.

---

## Error handling

| Variant             | Cause                                              |
|---------------------|----------------------------------------------------|
| `BridgeError::Io`   | `stdin.write_all` / `Command::spawn` failed        |
| `BridgeError::Json` | Request serialisation error                        |
| `BridgeError::Rpc`  | Sidecar returned `{"error": ...}`                  |
| `BridgeError::ReaderDead` | Reader thread exited; channel closed         |
| `BridgeError::NotReady`  | `{"ready":true}` not received within timeout  |

---

## Key design decisions

**Pending map + per-call mpsc channel** — each `call()` registers a
`SyncSender<RpcResponse>` keyed by UUID in a shared `HashMap`.  The reader
thread removes and fires the sender on receipt.  This gives each call a private
rendezvous point with zero shared state between concurrent callers.

**Ready signal via the same pending map** — the `"__ready__"` slot is inserted
before the reader thread starts, ensuring the signal is never missed.

**Drop impl kills the child** — `PythonBridge` implements `Drop` so the child
is always reaped even if `close()` is never called (e.g., after `?` unwinds).

**POSIX: SIGTERM then SIGKILL** — `close()` sends SIGTERM first and polls with
`try_wait()` for 500 ms before escalating to `child.kill()` (SIGKILL).  On
Windows the SIGTERM block is gated behind `#[cfg(unix)]`.

---

## See also

- [`edge-cases.md`](./edge-cases.md) — ownership, thread panics, venv paths,
  Windows quirks, pipe back-pressure.
- [`future-scope.md`](./future-scope.md) — tokio async client, PyO3,
  shared-memory transport, gRPC, WASM sidecar.
