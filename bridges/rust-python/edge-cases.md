# Edge Cases — Rust→Python Bridge

## 1. Ownership and thread safety: `RpcResponse` must be `Send + 'static`

Rust's mpsc channels require the message type to satisfy `Send + 'static`.
`RpcResponse` must therefore own all its data (no borrowed `&str` fields).
Use `String` instead of `&str`, and `Option<Value>` (owned) for the result.
If you add a custom type to the response, derive or implement `Send` explicitly
and ensure no `Rc<T>` or raw-pointer fields sneak in.

## 2. mpsc vs crossbeam for multi-producer concurrent calls

`std::sync::mpsc` is *multi-producer, single-consumer*.  In this bridge each
`call()` creates a fresh one-shot channel (`sync_channel(1)`) so there is only
ever one producer and one consumer per in-flight request.  This is safe.

If you want multiple Rust threads to share *one* `Bridge` instance and call
`call()` concurrently, you must wrap `Bridge` in `Arc<Mutex<Bridge>>` or
restructure so that:

- The stdin write and the channel registration are done atomically (hold the
  pending-map lock for both, or pre-register before writing).
- Consider [`crossbeam-channel`](https://crates.io/crates/crossbeam-channel)
  for bounded channels with better performance under contention, but the
  per-call isolation pattern works fine with std mpsc.

## 3. Python venv path: use `std::env`, not hardcoded strings

Never hardcode `/home/user/project/venv/bin/python`.  Build the path at
runtime:

```rust
let cwd = std::env::current_dir()?;
#[cfg(unix)]    let python = cwd.join("venv/bin/python");
#[cfg(windows)] let python = cwd.join("venv/Scripts/python.exe");
let python = if python.exists() { python } else { PathBuf::from("python3") };
```

Alternatively accept `PYTHON_PATH` from the environment so CI can inject the
correct interpreter without recompiling.

## 4. Reader thread panic propagates as `ReaderDead`

If the reader thread panics (e.g., a bug in the dispatch loop), its
`JoinHandle` is never explicitly joined, so the panic is silently swallowed.
The symptom is that `call()` blocks forever or returns `RecvError` (mapped to
`BridgeError::ReaderDead`).

Mitigations:
- Wrap the reader body in `std::panic::catch_unwind` and drain all pending
  senders with an error response before the thread exits.
- Use a shared `AtomicBool` flag that the reader sets on exit; `call()` checks
  it before blocking on `recv()`.
- Join the reader in `close()` and propagate any panic message.

## 5. `Drop` impl must kill the child

Without a `Drop` impl, if `PythonBridge` goes out of scope without `close()`
being called (e.g., after a `?` early-return), the child process becomes a
zombie.  Always implement:

```rust
impl Drop for PythonBridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();  // reap to avoid zombies
    }
}
```

Ignore errors in `Drop` — the process may already be dead.

## 6. Windows: venv path and signal handling

On Windows:
- The Python interpreter is at `venv\Scripts\python.exe`, not `venv/bin/python`.
- `SIGTERM` is not a real OS signal; `child.kill()` sends `TerminateProcess`
  which is immediate and equivalent to SIGKILL.  Do not attempt `libc::kill`
  with SIGTERM on Windows — gate it behind `#[cfg(unix)]`.
- Use `std::env::var("COMSPEC")` or `where python` to locate a system Python
  if no venv is present.

## 7. Ready-signal race condition

Register the `"__ready__"` slot in the pending map *before* spawning the
reader thread.  If you register it after, the reader may process the
`{"ready":true}` line and find no slot, discarding the signal, causing
`recv_timeout` to expire with `BridgeError::NotReady`.

## 8. Stray `print()` in Python imports corrupts the JSON stream

The `sys.stdout = sys.stderr` redirect must be the very first statement in the
sidecar script — before `import` lines.  Some libraries (notably `tqdm`,
`transformers`, logging handlers, and `__init__.py` side-effects) print to
stdout on import.  Any non-JSON output before `{"ready":true}` will cause the
Rust reader to log a parse error and the ready handshake may fail.

## 9. Large payloads and back-pressure

`stdio` buffers are finite.  If the sidecar is slow and the Rust side sends
many large requests without reading responses, the OS pipe buffer fills and
`stdin.write_all()` blocks indefinitely.  For high-throughput use cases:
- Limit in-flight requests (semaphore).
- Use a dedicated writer thread so `call()` never blocks on the write path.
- Consider a socket-based transport instead of stdio.

## 10. Blocking `child.wait()` after `stdin` close

After dropping stdin (EOF), `child.wait()` blocks until the child exits.  If
the sidecar has a bug that causes it to loop without reading stdin, `wait()`
hangs.  Always pair with a timeout loop using `child.try_wait()` and escalate
to `child.kill()` after the grace period.
