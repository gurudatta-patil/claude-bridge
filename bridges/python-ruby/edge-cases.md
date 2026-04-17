# Edge Cases: Python → Ruby Bridge

This document covers pitfalls that are specific to the Python-client /
Ruby-sidecar pairing.  Generic JSON-RPC-over-stdio concerns are covered in
the top-level project documentation.

---

## 1. Python subprocess stdout read blocking — always use a thread reader

`subprocess.Popen` gives you a raw `stdout` pipe.  If you call
`proc.stdout.read()` or even `proc.stdout.readline()` on the **main thread**
while also writing to `proc.stdin`, you can deadlock: the OS pipe buffer fills
up and both processes block waiting for the other to drain.

**Rule:** always start a dedicated **daemon thread** that loops on
`proc.stdout.readline()` and never block the calling thread directly on
stdout reads.

```python
# WRONG — blocks the calling thread and risks deadlock
line = proc.stdout.readline()

# CORRECT — let the reader thread handle it; block only on a Queue
reader_thread = threading.Thread(target=reader_loop, daemon=True)
reader_thread.start()
response = response_queue.get(timeout=30)
```

---

## 2. Deadlock: writing to stdin while blocked reading stdout

The classic subprocess deadlock:

1. Python writes a large request to `proc.stdin`.
2. The OS pipe buffer for **stdin** fills up — Python blocks inside `write()`.
3. Ruby has not read the request yet because it is blocked writing a large
   **stdout** response to a full pipe.
4. Neither side can proceed.

Mitigations already baked into the template:

* The reader daemon thread continuously drains `proc.stdout`, so the Ruby→Python
  pipe never fills.
* The stderr drain thread prevents the stderr pipe from filling and causing
  Ruby to block on writes to `$stderr`.
* `proc.stdin.flush()` is called after every write so bytes leave the Python
  buffer promptly.

---

## 3. Ruby startup and Bundler overhead

A bare `ruby sidecar.rb` starts in ~50–100 ms on modern hardware, but if the
sidecar uses `bundle exec ruby sidecar.rb` the overhead can reach 500 ms–2 s
on cold starts (Bundler resolves the gem graph every time).

Strategies:

* Use `BUNDLE_PATH` + `bundle install --deployment` so resolution is fast.
* Consider `bundle exec --keep-file-descriptors` to avoid descriptor leaks.
* Set `ready_timeout` in `RubyBridge.__init__` to at least **10 seconds** for
  Bundler-backed sidecars.
* Cache the resolved bundle with `BUNDLE_FROZEN=1` in production.

---

## 4. Python signal handling in multithreaded contexts

Python delivers signals **only to the main thread**.  This has two
consequences for the bridge:

### 4a. `signal.signal()` must be called from the main thread

The `_install_signal_handlers()` method checks
`threading.current_thread() is threading.main_thread()` and silently skips
installation if called from a worker thread.  If you construct `RubyBridge`
inside a thread pool you lose automatic cleanup — call `bridge.close()`
manually in your thread's `finally` block.

### 4b. `queue.Queue.get(timeout=...)` is interruptible by SIGINT

When the user presses Ctrl-C while a `call()` is in-flight, Python raises
`KeyboardInterrupt` inside `queue.get()`.  The signal handler installed by
`_install_signal_handlers` catches SIGINT, calls `close()`, then re-raises
with the default handler so the process exits cleanly.

---

## 5. `bytes` vs `str` — subprocess pipes return `bytes`

`proc.stdout.readline()` returns `bytes`, not `str`.  Always decode:

```python
line = proc.stdout.readline().decode("utf-8", errors="replace").strip()
```

Using `errors="replace"` prevents a `UnicodeDecodeError` from crashing the
reader thread if the sidecar accidentally emits non-UTF-8 bytes (e.g. from a
C extension or a binary log line).

Similarly, writes to `proc.stdin` must be bytes:

```python
proc.stdin.write((json_line + "\n").encode("utf-8"))
```

---

## 6. Windows subprocess buffering differences

On Windows, `subprocess.PIPE` has different buffering characteristics:

* The default pipe buffer is 4 KB (vs 64 KB on Linux/macOS).  Large payloads
  are more likely to trigger the deadlock described in §2.
* `SIGTERM` does not exist on Windows; use `proc.terminate()` instead of
  `proc.send_signal(signal.SIGTERM)`.  The template's `close()` should be
  patched for Windows deployments:

```python
import sys
if sys.platform == "win32":
    proc.terminate()
else:
    proc.send_signal(signal.SIGTERM)
```

* Ruby on Windows may emit CRLF line endings.  Strip with `.strip()` (which
  removes both `\r` and `\n`) rather than `.rstrip("\n")`.

* Console window creation: pass `creationflags=subprocess.CREATE_NO_WINDOW`
  to `Popen` on Windows to prevent a cmd.exe window from flashing up.

---

## 7. `$stdout.sync = true` is mandatory in the Ruby sidecar

Without it, Ruby's `IO` layer buffers stdout in 8 KB blocks.  The Python
client's reader thread will block indefinitely waiting for a line that is
sitting in Ruby's internal buffer.  The first line in every sidecar **must**
be:

```ruby
$stdout.sync = true
```

---

## 8. JSON integer overflow (Ruby `Integer` vs Python `int`)

Ruby's `Integer` is arbitrary precision; Python's `json` module decodes
integers as Python `int` (also arbitrary precision).  However, if you pass
a number larger than 2^53 via JSON it will lose precision in any JavaScript-
based intermediary.  For the Python↔Ruby pair this is not an issue, but keep
it in mind if the same protocol message is ever relayed through a browser or
Node.js layer.

---

## 9. Thread-safety of `proc.stdin.write`

`proc.stdin` is a `BufferedWriter`.  Concurrent writes from multiple threads
**will interleave** JSON fragments and corrupt the wire format.  The template
serialises all writes through a single `_write_line()` call protected by the
GIL for small writes, but for safety in performance-sensitive code add an
explicit `threading.Lock` around `_write_line`.

---

## 10. Zombie processes if `close()` is never called

If `RubyBridge` is garbage-collected without `close()` being called, the Ruby
process becomes a zombie until Python's GC or OS reaps it.  Always use the
context manager (`with RubyBridge(...) as bridge:`) or call `bridge.close()`
in a `finally` block.
