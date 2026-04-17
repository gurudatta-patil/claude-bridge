# Edge Cases — Rust → Go Bridge

This document captures Rust-to-Go specific edge cases you must handle when
operating Ghost-Bridge in production or when building on top of the templates.

---

## 1. Both Are Compiled Languages — Build Order Matters

Unlike a scripting-language sidecar, the Go binary must be compiled before the
Rust client can spawn it.  An MCP server that orchestrates both must:

1. Run `go build -o <output> ./path/to/sidecar` as a pre-flight step.
2. Verify the output binary exists and is executable before the Rust client
   launches.
3. Cache the build artifact; re-build only when source files change (use a
   checksum or `go build`'s own incremental cache).

If the Go binary is missing, `std::process::Command::spawn` will return
`ErrorKind::NotFound` and the bridge will never reach the ready handshake.

---

## 2. bufio.Scanner 64 KB Default Limit

Go's `bufio.Scanner` uses a 64 KB token buffer by default.  A JSON-RPC line
carrying a base64-encoded payload larger than ~48 KB will cause:

```
bufio.Scanner: token too long
```

The scanner silently stops (returns `false`) without writing any error response,
which looks like a hang or unexpected EOF to the Rust side.

**Fix (already applied in templates):**

```go
const maxBuffer = 4 * 1024 * 1024 // 4 MB
scanner.Buffer(make([]byte, maxBuffer), maxBuffer)
```

Choose a buffer size appropriate to your largest expected payload.  For very
large blobs, consider chunking at the application layer rather than embedding
them in a single JSON-RPC message.

---

## 3. Rust's Strict Types vs Go's `interface{}`

Rust's `serde_json` and Go's `encoding/json` disagree on several numeric edge
cases:

| Scenario | Rust (`serde_json`) | Go (`encoding/json`) |
|---|---|---|
| `{"n": 42}` decoded to `f64` | `42.0` | `float64(42)` — same |
| Integer overflow (> i64::MAX) | parse error | silently wraps or uses `float64` |
| `null` field | `Value::Null` | `nil` interface / zero value |
| Unknown fields | ignored by default | ignored by default |
| Extra whitespace in JSON | OK | OK |

**Practical rules:**

- Always use `json.RawMessage` for `params` in Go and decode inside each handler
  — this defers type coercion to where you know the schema.
- When Rust sends an integer as `serde_json::Value::Number`, Go decodes it as
  `float64` by default.  Use `json.Number` or decode into a typed struct to
  preserve integer semantics.
- Never rely on field ordering in JSON objects — both languages produce arbitrary
  ordering.

---

## 4. JSON Serialisation Dominates Latency, Not Process Spawn

Both Rust and Go have sub-millisecond startup times.  For a long-lived sidecar
process (the Ghost-Bridge model), **amortised startup cost is zero**.

Measured on a 2024 developer laptop:

| Operation | Typical latency |
|---|---|
| Go binary startup + ready handshake | 5–15 ms (one-time) |
| Round-trip for a small JSON call | 0.1–0.5 ms |
| `serde_json::to_string` (1 KB payload) | ~2 µs |
| `json.Marshal` (1 KB payload) | ~3 µs |
| 128 KB base64 round-trip | ~1–3 ms |

Optimisation focus: reduce payload size and avoid unnecessary allocations in
hot-path handlers rather than trying to speed up process spawn.

---

## 5. Cross-Compilation Matrix

Both languages support cross-compilation, but the path differs:

### Rust

```bash
rustup target add aarch64-apple-darwin
cargo build --target aarch64-apple-darwin --release
```

No external linker is needed for pure-Rust builds.  CGo-dependent Go sidecars
require a cross-linker (see section 6 in future-scope.md).

### Go

```bash
GOOS=linux GOARCH=arm64 go build -o sidecar-linux-arm64 .
```

Go cross-compiles to any supported target without additional toolchain setup
as long as you are not using CGo.

**Implication for CI:** your build pipeline must cross-compile both artefacts
for the target platform.  They do not need to match architectures during
development (e.g., build Go for `linux/amd64` on an Apple Silicon Mac is fine),
but the final deployed pair must match the host OS/architecture.

---

## 6. Windows: EOF and Signal Handling

### EOF (stdin close)

Both Rust (`drop(stdin)`) and Go (`scanner.Scan()` returning `false`) handle
stdin EOF identically on Windows.  The protocol shutdown path works correctly
cross-platform.

### Signals

Windows does not support POSIX signals.  Specific implications:

- `SIGTERM` does not exist on Windows.  Go's `signal.Notify(ch, syscall.SIGTERM)`
  compiles but the signal is never delivered; the channel will block forever.
  Use `os.Interrupt` (Ctrl-C) instead, or rely purely on stdin-EOF.
- Rust's `child.kill()` sends `TerminateProcess` on Windows (equivalent to
  SIGKILL); it is always available.
- The optional `nix` crate for POSIX SIGTERM must be feature-gated:
  ```toml
  [target.'cfg(unix)'.dependencies]
  nix = { version = "0.27", features = ["signal"] }
  ```
- For cross-platform graceful shutdown, prefer the stdin-EOF path over signals.

---

## 7. Buffered Writer Must Be Flushed After Every Write

Go's `bufio.NewWriter` accumulates bytes in a 4 KB internal buffer.  If you
forget to call `Flush()` after every JSON line, the Rust client will block
waiting for a response that is sitting in the buffer.

**Rule:** call `stdout.Flush()` immediately after every `fmt.Fprintln(stdout, ...)`.
The templates enforce this in `writeJSON`.

---

## 8. Reader Thread — Never Block the Dispatch Loop

The Rust reader thread calls `BufReader::lines()` in a tight loop.  If a Go
handler blocks indefinitely (e.g., a deadlocked channel), the response never
arrives and the Rust `rx.recv_timeout()` will expire.  The pending entry leaks
until the bridge is dropped.

**Mitigation:** always set a call timeout in production code using
`Bridge::call_timeout`.  On the Go side, use `context.WithTimeout` inside slow
handlers.

---

## 9. ID Uniqueness and UUID Version

Request IDs are UUIDs v4 (random).  The Go sidecar echoes them back verbatim —
it never generates IDs.  Collision probability across 2^122 random bits is
negligible for any realistic call volume.

If you replace the `uuid` crate with a monotonic counter, ensure the counter is
guarded by a mutex (the `call` method takes `&mut self` so this is automatic in
single-threaded use, but `Arc<Mutex<Bridge>>` patterns require explicit locking).

---

## 10. Process Zombie Reaping

If the Rust process drops a `GoBridge` without calling `shutdown()`, the `Drop`
impl calls `child.kill()` followed by `child.wait()`.  The `wait()` call is
essential — without it the child becomes a zombie process on POSIX systems.

Never skip `child.wait()` after `child.kill()`.
