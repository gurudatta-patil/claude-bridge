# Ghost-Bridge — Rust → Ruby

Seamless cross-language IPC between a **Rust caller** and a **Ruby sidecar**
over newline-delimited JSON-RPC 2.0 on stdio.

---

## Directory layout

```
bridges/rust-ruby/
├── template.client/          Rust client template (replace [CLAUDE_*] placeholders)
│   ├── Cargo.toml
│   └── src/main.rs           RubyBridge struct + demo main()
├── template.sidecar.rb       Ruby sidecar template (replace [CLAUDE_*] placeholders)
├── tests/
│   ├── test-child.rb         Real Ruby sidecar: echo, add, raise_error, echo_b64, slow
│   ├── rust-ruby_test.rs     #[cfg(test)] integration tests
│   └── test-runner/          Standalone Rust binary test runner
│       ├── Cargo.toml
│       └── src/main.rs
├── edge-cases.md             Rust→Ruby specific gotchas
├── future-scope.md           JRuby, Rutie, gRPC, WASM ideas
└── README.md                 This file
```

---

## Protocol

```
child stdout →  {"ready":true}\n                    (first line, always)

client → child  {"jsonrpc":"2.0","id":"<uuid>","method":"...","params":{...}}\n
child → client  {"jsonrpc":"2.0","id":"<uuid>","result":{...}}\n   (success)
child → client  {"jsonrpc":"2.0","id":"<uuid>","error":{"code":...,"message":"..."}}\n
```

- One JSON object per line; `\n` terminated.
- Closing stdin is the shutdown signal; the Ruby sidecar exits when `$stdin`
  reaches EOF.

---

## Quick start

### 1. Use the template

Copy the two templates and replace every `[CLAUDE_*]` placeholder:

| Placeholder | Meaning |
|---|---|
| `[CLAUDE_SIDECAR_PATH]` | Absolute or relative path to the `.rb` sidecar |
| `[CLAUDE_METHOD_NAME]` | JSON-RPC method name the sidecar handles |
| `[CLAUDE_METHOD_BODY]` | Ruby expression that produces the `result` value |
| `[CLAUDE_PARAMS]` | JSON string for the demo call's params |
| `[CLAUDE_METHOD]` | JSON-RPC method name for the Rust demo call |
| `[CLAUDE_EXTRA_REQUIRES]` | Additional `require` lines, or delete |

### 2. Run the integration tests

```bash
# From the bridges/rust-ruby/ directory:
cargo run --manifest-path tests/test-runner/Cargo.toml
```

Or add `tests/rust-ruby_test.rs` to your workspace's integration test target
and run `cargo test`.

### 3. Run just the Ruby sidecar for manual testing

```bash
ruby tests/test-child.rb
# Type a JSON-RPC request and press Enter:
{"jsonrpc":"2.0","id":"1","method":"add","params":{"a":1,"b":2}}
# Response:
{"jsonrpc":"2.0","id":"1","result":{"sum":3.0}}
```

---

## Rust client API

```rust
// Spawn Ruby, wait up to 5 s for the ready handshake
let mut bridge = RubyBridge::spawn("path/to/sidecar.rb", Duration::from_secs(5))?;

// Call a method, wait up to 10 s for a response
let result: serde_json::Value = bridge.call(
    "add",
    json!({ "a": 40, "b": 2 }),
    Duration::from_secs(10),
)?;

// Graceful shutdown: close stdin, child exits via EOF
bridge.close();
// Drop also calls close() + kill() for safety
```

---

## Ruby sidecar rules

Every sidecar **must**:

1. Set `$stdout.sync = true; $stderr.sync = true` as the first two lines.
2. Write `{"ready":true}` to stdout before reading any input.
3. Use `rescue => e` (StandardError) in the main loop for application errors.
4. Use `e.full_message` when logging errors to `$stderr`.
5. Trap `TERM` and `INT` signals.
6. Exit cleanly when `$stdin.each_line` terminates (EOF).

---

## Edge cases summary

See [`edge-cases.md`](edge-cases.md) for full details.

| # | Issue | Key rule |
|---|---|---|
| 1 | Ruby cold-start 100–500 ms | Use ≥ 2 s ready_timeout |
| 2 | stdout buffering | `$stdout.sync = true` is mandatory |
| 3 | Exception hierarchy | Use `rescue => e`, not `rescue Exception` |
| 4 | Windows encoding | Add `-E UTF-8:UTF-8` flag on Windows |
| 5 | Drop order | Close stdin before kill/wait |
| 6 | Line framing | Always `flush()` after `writeln!` |
| 7 | Single reader thread | One reader thread per child process |
| 8 | Large payloads | Drain pipe continuously; reader runs independently |

---

## Dependencies

### Rust (`template.client/Cargo.toml`)

| Crate | Purpose |
|---|---|
| `serde` + `serde_json` | JSON serialisation |
| `uuid` (v4 feature) | Unique request IDs |
| `ctrlc` (termination feature) | Ctrl-C handler |

### Ruby (stdlib only)

| Library | Purpose |
|---|---|
| `json` | JSON parse/generate |
| `base64` | Base64 encode/decode (echo_b64 method) |

No gems required for the sidecar template or test child.

---

## Future scope

See [`future-scope.md`](future-scope.md) for:
- JRuby for multi-core concurrency (no GVL)
- Rutie — Rust↔Ruby FFI as a zero-IPC alternative
- gRPC / Cap'n Proto transport upgrade
- Connection pooling
- WASM/WASI Ruby
