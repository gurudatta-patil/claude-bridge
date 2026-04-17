# Python → Rust Edge Cases

## 1. Compile Step Integration

**Problem:** The Rust binary must exist before `RustBridge` can be started.  
**Pattern:** Call `build_sidecar()` (wraps `cargo build --release`) in your
test fixture or CI step, not inside `RustBridge.__init__`.

```python
from template_client import build_sidecar, RustBridge

binary = build_sidecar("path/to/sidecar", release=True)
with RustBridge(binary) as bridge:
    ...
```

**Windows note:** `build_sidecar` automatically appends `.exe` on Windows.
For cross-compilation pass `target="x86_64-pc-windows-gnu"` and ensure the
correct linker is installed.

---

## 2. Rust `panic!` vs `Err` — reader hang risk

`panic!` terminates the process without writing any JSON to stdout.  
The Python reader thread will block on `event.wait(timeout=...)` until the
call timeout expires, then raise `TimeoutError` rather than a clean
`BridgeError`.

**Rule:** Every Rust handler **must** return `io::Result<()>` and use
`write_error(…)` for application-level errors.  Never call `panic!`,
`unwrap()`, or `expect()` on paths reachable from a request handler.

```rust
// BAD — Python caller hangs until timeout
fn handle_add(out: &mut impl Write, req: &Request) -> io::Result<()> {
    let a = req.params["a"].as_i64().unwrap();  // panics if missing
    ...
}

// GOOD
fn handle_add(out: &mut impl Write, req: &Request) -> io::Result<()> {
    let a = match req.params["a"].as_i64() {
        Some(v) => v,
        None => return write_error(out, &req.id, -32602, "missing param: a"),
    };
    ...
}
```

---

## 3. `BufWriter` Flush Discipline

`BufWriter` batches writes for performance.  If you write a response line but
do **not** flush, the Python client will block indefinitely.

**Rule:** Call `out.flush()` immediately after every `writeln!(out, …)`.
Both helper functions (`write_success`, `write_error`) in the templates
already do this.

```rust
// BAD
writeln!(out, "{}", response_json)?;
// flush missing — Python hangs

// GOOD
writeln!(out, "{}", response_json)?;
out.flush()?;
```

---

## 4. Python `bytes` vs `str` — subprocess pipe decoding

`subprocess.PIPE` returns `bytes` on all platforms.  The reader thread must
explicitly decode before calling `json.loads`.

```python
# BAD — json.loads(bytes) works in Python 3.6+ but is slower and
#        can mask encoding issues
json.loads(raw_line)

# GOOD
json.loads(raw_line.decode("utf-8", errors="replace"))
```

Also ensure you **encode** before writing to stdin:

```python
self._proc.stdin.write(line.encode("utf-8"))
```

---

## 5. Rust Integer Types vs Python Arbitrary Precision

Rust `i64` has a range of `−2⁶³` to `2⁶³−1`.  Python integers are unbounded.

**Truncation risk:** If Python sends a number outside the `i64` range,
`serde_json` will fail to deserialize it (returns `None` from `as_i64()`),
causing an application-level error — which is safe.  The dangerous case is
silent truncation, which does **not** occur with `serde_json`; you will get
an error instead.

**Recommendation:** Document the `i64` constraint in your method schema and
validate on the Python side for any arithmetic-heavy API.

```python
MAX_I64 = (1 << 63) - 1
if not (-MAX_I64 - 1 <= value <= MAX_I64):
    raise ValueError(f"Value {value} exceeds i64 range")
```

---

## 6. Windows Binary Path

On Windows, Cargo produces `<name>.exe`.  `build_sidecar()` handles this
automatically via `sys.platform`:

```python
if sys.platform == "win32":
    binary_path = binary_path.with_suffix(".exe")
```

For cross-compilation from macOS/Linux to Windows you need a cross-linker
(e.g. `x86_64-w64-mingw32-gcc`) and the `x86_64-pc-windows-gnu` Rust target.

---

## 7. Stderr Separation

The Rust template uses `eprintln!()` for all debug output.  Python's
`subprocess.Popen` is created with `stderr=subprocess.PIPE` so that Rust
debug lines do **not** mix with the JSON stdout stream.

If you need to surface Rust stderr in tests, read from `proc.stderr` in a
separate daemon thread to avoid the pipe buffer filling up and deadlocking
the child process.

---

## 8. Slow Method + Python Timeout Interaction

`bridge.call("slow", {"ms": 10000}, timeout=0.5)` raises `TimeoutError` on
the Python side, but the Rust sidecar **keeps running** and will eventually
write the response to stdout.  The orphaned response will be silently
discarded by the reader thread (the pending entry has already been removed).

This is safe.  However, if you close the bridge while many slow calls are in
flight, some Rust threads may attempt to write to a closed pipe, producing
`BrokenPipe` errors in `eprintln!` — which is benign.

---

## 9. Signal Handling Race on macOS/Linux

The `ctrlc` crate intercepts `SIGTERM` and `SIGINT`.  On process exit
(stdin EOF), the child exits via normal loop termination — no signal is
needed.  The Python bridge sends EOF by closing `proc.stdin`, then waits
2 s before escalating to `SIGKILL`.

Do **not** call `std::process::exit(0)` inside a signal handler that holds
a `MutexGuard` — this will deadlock.  Use an `AtomicBool` shutdown flag and
break out of the main loop cleanly.

---

## 10. JSON Parse Error Fallback

When Rust receives a line that is not valid JSON it cannot know the `id`.
The template writes `{"id":"null","error":{"code":-32700,"message":"..."}}`.
The Python reader will not match this to any pending call (no pending entry
has id `"null"`), so it is silently dropped.  This prevents a crash but the
caller will eventually time out.

**Mitigation:** Validate JSON on the Python side before sending, or wrap
send-side logic in a try/except and surface the error immediately.
