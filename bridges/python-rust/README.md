# Stitch: Python → Rust

Spawn a compiled Rust binary as a child process and communicate with it over
newline-delimited JSON-RPC on stdin/stdout.

```
Python caller
    │  JSON-RPC (newline-delimited, via subprocess pipe)
    ▼
Rust sidecar (compiled binary)
```

---

## Directory layout

```
bridges/python-rust/
├── template.client.py          # Python RustBridge class + build_sidecar()
├── template.sidecar/
│   ├── Cargo.toml
│   └── src/main.rs             # Rust sidecar template with [CLAUDE_*] stubs
├── tests/
│   ├── test-child/
│   │   ├── Cargo.toml
│   │   └── src/main.rs         # Real sidecar: echo, add, raise_error, echo_b64, slow
│   ├── test-client.py          # Manual smoke-test script
│   └── python-rust_test.py     # pytest suite
├── edge-cases.md               # Python→Rust gotchas
├── future-scope.md             # Ideas for extension
└── README.md                   # This file
```

---

## Protocol

| Direction | Message |
|---|---|
| Child → Python (startup) | `{"ready":true}` |
| Python → Child | `{"id":"<uuid4>","method":"<name>","params":{…}}` |
| Child → Python (success) | `{"id":"<uuid4>","result":<value>}` |
| Child → Python (error) | `{"id":"<uuid4>","error":{"code":<i32>,"message":"<str>"}}` |

- Every message is a single UTF-8 line terminated by `\n`.
- Stdin EOF signals the child to exit cleanly.
- Rust debug output goes to **stderr** only (`eprintln!`).

---

## Quick start

### 1. Build the test-child binary

```bash
cargo build --release --manifest-path bridges/python-rust/tests/test-child/Cargo.toml
```

### 2. Run the manual smoke test

```bash
python bridges/python-rust/tests/test-client.py
```

### 3. Run the full pytest suite

```bash
pytest bridges/python-rust/tests/python-rust_test.py -v
```

The first test (`test_build`) will run `cargo build` automatically if the
binary is not already present.

---

## Using the Python client

```python
from template_client import RustBridge, BridgeError, build_sidecar

# Build the Rust binary (once per session / CI step)
binary = build_sidecar("path/to/my-sidecar", release=True)

# Context manager — recommended
with RustBridge(binary) as bridge:
    result = bridge.call("add", {"a": 1, "b": 2})   # -> 3
    echo   = bridge.call("echo", {"msg": "hi"})       # -> "hi"

# Error handling
with RustBridge(binary) as bridge:
    try:
        bridge.call("raise_error", {"code": 42, "msg": "boom"})
    except BridgeError as exc:
        print(exc.code, exc.message)   # 42  boom
```

### `RustBridge` constructor parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `binary_path` | `str \| Path` | — | Path to the compiled Rust binary |
| `args` | `list[str]` | `[]` | Extra CLI arguments for the binary |
| `startup_timeout` | `float` | `10.0` | Seconds to wait for `{"ready":true}` |
| `call_timeout` | `float` | `30.0` | Default per-call timeout in seconds |
| `env` | `dict` | `None` | Extra environment variables |

---

## Writing a new Rust sidecar

Start from `template.sidecar/src/main.rs` and replace the `[CLAUDE_*]`
markers:

| Marker | What to do |
|---|---|
| `[CLAUDE_STATE]` | Add shared state fields (DB handles, caches, etc.) |
| `[CLAUDE_DISPATCH]` | Add `"method_name" => handle_method(out, req)` arms |
| `[CLAUDE_HANDLERS]` | Implement one `fn handle_*` per method |
| `[CLAUDE_METHOD]` | Example method entries for the dispatch table |

### Handler pattern

```rust
fn handle_greet(out: &mut impl Write, req: &Request) -> io::Result<()> {
    let name = match req.params["name"].as_str() {
        Some(s) => s.to_owned(),
        None => return write_error(out, &req.id, -32602, "missing param: name"),
    };
    write_success(out, &req.id, format!("Hello, {name}!"))
}
```

### Key rules

1. **Never** call `panic!`, `unwrap()`, or `expect()` inside a handler —
   the Python caller will hang until timeout.  Use `write_error` instead.
2. **Always** flush after every write — `write_success` and `write_error`
   both call `out.flush()` already.
3. Send debug output to **stderr** with `eprintln!`, never to stdout.

---

## Test-child methods

| Method | Params | Returns |
|---|---|---|
| `echo` | `{"msg": str}` | `str` — the same string |
| `add` | `{"a": i64, "b": i64}` | `i64` — sum |
| `raise_error` | `{"code": i32, "msg": str}` | error with given code/message |
| `echo_b64` | `{"data": base64_str}` | `base64_str` — round-tripped |
| `slow` | `{"ms": u64}` | `"done"` after sleeping *ms* milliseconds |

---

## Edge cases

See [`edge-cases.md`](edge-cases.md) for detailed coverage of:

- Rust `panic!` vs `Err` (reader hang risk)
- `BufWriter` flush discipline
- Python `bytes` / `str` pipe decoding
- `i64` truncation for large Python ints
- Windows `.exe` path handling
- Stderr separation to avoid pipe deadlock
- Slow call + timeout interaction
- Signal handling race conditions

---

## Future scope

See [`future-scope.md`](future-scope.md) for ideas including:

- `ts-rs` for cross-language type schema generation
- `mmap` for large array transfer (faster than Base64)
- C FFI / PyO3 as a lower-latency alternative
- Async Python client with `asyncio`
- Schema validation middleware
- Connection pooling for high call rates
- Protocol versioning and capability negotiation
