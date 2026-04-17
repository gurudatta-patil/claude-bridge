# Rust-specific Edge Cases

## 1. Compile step required before spawning

Unlike interpreted languages (Python, Node), a Rust sidecar must be compiled
before it can be spawned.  The MCP server or test harness is responsible for
running:

```sh
cargo build --release
```

inside the crate directory.  Attempting to spawn a non-existent binary produces
an `ENOENT` spawn error in Node, which manifests as an immediate `error` event
on the `ChildProcess` object rather than a readable message — always check that
the binary exists before calling `start()`.

## 2. Binary size and cold-start latency

A release-optimised Rust binary with `opt-level = "z"`, `lto = true`, and
`strip = true` typically weighs 200 – 800 KB and starts in **< 5 ms** on
modern hardware.  Compare this to a CPython sidecar, which must import the
interpreter and modules (often 80–300 ms on first launch).  The trade-off is
the one-time compile cost (seconds to minutes depending on dependency count).

## 3. `panic!` vs `Result` — Node hangs on unhandled panics

A `panic!` in Rust prints a backtrace to **stderr** and then aborts the
process (or unwinds, depending on the panic strategy).  It does **not** write a
JSON error object to stdout.  From Node's perspective the child simply exits
with a non-zero code without producing a response, causing all in-flight
`Promise`s to remain pending until the `exit` event fires and the client's
`rejectAll()` path runs.

Mitigation: wrap every dispatch arm in a `Result`-returning function and never
use `unwrap()` or `expect()` in production paths.  Use `eprintln!()` for
diagnostic output.

## 4. `BufWriter` — forgetting `.flush()` causes Node to hang indefinitely

`BufWriter` accumulates bytes in an internal buffer and only flushes to the
underlying file descriptor when the buffer is full or explicitly flushed.  The
JSON-RPC response for a typical call is far smaller than the default 8 KB
buffer, so it **will not be written to stdout** until `.flush()` is called.
Node will block on `stdout.on("data", …)` indefinitely.

Rule: call `out.flush().expect("flush")` immediately after every `writeln!`,
including the `{"ready":true}` line.

## 5. Windows — `.exe` extension in binary path

On Windows, Cargo produces `<name>.exe` rather than `<name>`.  The client path
helper must check `os.platform() === "win32"` and append `.exe` accordingly.
CI pipelines that test on both POSIX and Windows must account for this in any
shell scripts or `execSync` calls.

## 6. Cross-compilation for CI (x86_64 vs arm64)

GitHub Actions runners are typically `ubuntu-latest` (x86_64) or
`macos-latest` (arm64 since late 2023).  A binary compiled on one
architecture will not run on the other.  Options:

- Compile on the target runner natively (simplest).
- Use `cross` (<https://github.com/cross-rs/cross>) for Docker-based
  cross-compilation.
- Build a universal macOS binary with
  `cargo build --release --target aarch64-apple-darwin` +
  `x86_64-apple-darwin` then `lipo -create`.

The `.stitch/rust/<bridge>/target/release/` path must therefore be
treated as platform-specific and never committed to version control.

## 7. `serde_json` number types — `i64` vs `f64`

JSON has a single `number` type.  `serde_json` deserialises JSON numbers into
`Value::Number`, which internally stores either an `i64`, `u64`, or `f64`.
Calling `.as_i64()` on a value that was serialised as `3.0` returns `None`
because `3.0` is stored as `f64`.  Always use `.as_f64()` (which succeeds for
both integer and floating-point JSON numbers) when the input type is unknown,
and cast to integer only when you are certain the value has no fractional part.

```rust
// Fragile — returns None for 3.0
let n = params.get("n").and_then(Value::as_i64);

// Robust — accepts 3 and 3.0
let n = params.get("n").and_then(Value::as_f64).map(|f| f as i64);
```
