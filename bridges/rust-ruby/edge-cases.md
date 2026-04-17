# Edge Cases — Rust → Ruby Bridge

## 1. Ruby cold-start latency

**Problem.** A fresh `ruby` interpreter takes ~100 ms to start on a warm OS page
cache.  If the sidecar uses Bundler (`bundle exec ruby sidecar.rb`) the latency
jumps to ~500 ms because Bundler performs gem activation before the script runs.

**Impact.** Rust code that calls `RubyBridge::spawn` then immediately calls
`bridge.call(…)` with a short timeout may time out on the very first request,
even though nothing is logically wrong.

**Mitigations.**
- Pass a generous `ready_timeout` to `spawn` (≥ 2 s in production, ≥ 5 s in
  CI).
- Avoid Bundler for sidecars that only use stdlib (`json`, `base64`).
- Use `bundle exec --keep-file-descriptors` and pre-load Bundler in a wrapper
  script to amortise the cost.
- For latency-sensitive workloads, keep the sidecar process alive across
  multiple logical "sessions" (connection pool pattern).

---

## 2. `$stdout.sync = true` is not optional

**Problem.** Ruby buffers `$stdout` by default (block-buffered when stdout is a
pipe, line-buffered when it is a TTY).  Without `$stdout.sync = true`, `puts`
calls accumulate in Ruby's internal buffer and are only flushed when the buffer
fills (~8 KB) or the process exits.  Rust's `BufReader::lines()` will block
indefinitely waiting for data that is sitting in Ruby's write buffer.

**Impact.** The Rust side times out; the bridge appears to hang.

**Rule.** The very first lines of every sidecar must be:

```ruby
$stdout.sync = true
$stderr.sync = true
```

Adding `STDOUT.flush` after every `puts` is an alternative but error-prone;
`sync = true` is the canonical solution.

---

## 3. Ruby exception hierarchy

**Problem.** Ruby's exception tree has two important branches:

```
Exception
├── SignalException  (INT, TERM, KILL, …)
├── SystemExit
└── StandardError    ← what `rescue => e` catches
    ├── RuntimeError
    ├── ArgumentError
    ├── NoMethodError
    └── … (most application errors)
```

`rescue => e` is syntactic sugar for `rescue StandardError => e`.  It does
**not** catch `SignalException` or `SystemExit`.

**Impact.**
- In the main loop, `rescue => e` is correct for application errors.
- If you write `rescue Exception => e` in the main loop to "catch everything",
  you will swallow SIGTERM/SIGINT, preventing clean shutdown.
- Conversely, if the sidecar is supposed to catch signals and do cleanup, you
  must `rescue SignalException` (or `rescue Exception`) explicitly, then
  re-raise after cleanup.

**Rule.**  Use `rescue => e` (StandardError) in normal dispatch code.  Use
`rescue Exception` only in a dedicated signal-aware top-level wrapper, and
always re-raise.

---

## 4. Windows Ruby (RubyInstaller) differences

**Problem.** On Windows, RubyInstaller ships Ruby at a non-standard path and
defaults to the system ANSI code page (Windows-1252 / CP932, etc.) for
`$stdout` rather than UTF-8.

**Impacts.**
- `Command::new("ruby")` may fail if the RubyInstaller `bin` directory is not
  on `PATH`.  The Rust client must either add the Ruby bin directory to the
  child's environment or use the full path.
- Non-ASCII characters in JSON payloads (e.g., `"value": "こんにちは"`) may be
  mis-encoded.

**Mitigations.**
- At the top of the sidecar add:
  ```ruby
  $stdout.set_encoding('UTF-8')
  $stderr.set_encoding('UTF-8')
  $stdin.set_encoding('UTF-8')
  ```
- Or launch Ruby with the `-E UTF-8:UTF-8` flag:
  ```rust
  Command::new("ruby").arg("-E").arg("UTF-8:UTF-8").arg(sidecar_path)
  ```
- Locate Ruby via the `RUBY` environment variable, falling back to `where ruby`
  (Windows) or `which ruby` (Unix) at startup.

---

## 5. Rust drop order: stdin must be closed before `wait()`

**Problem.** Rust's `Drop` order for struct fields is top-to-bottom declaration
order.  If `ChildStdin` (or a `BufWriter<ChildStdin>`) is dropped *after*
`Child`, then:
1. `Child::drop` calls `child.kill()` (or `child.wait()`).
2. Ruby receives SIGKILL mid-readline and may leave partial output.

More critically: if you hold `ChildStdin` open and call `child.wait()`, the
parent blocks forever because Ruby's `$stdin.each_line` is still waiting for
more input.

**Rule.**
- In `Drop`, explicitly `drop(self.stdin_writer.take())` **before**
  `self.child.kill()` or `self.child.wait()`.
- Keep `stdin_writer` in an `Option<BufWriter<ChildStdin>>` so you can take
  and drop it on demand (see `Bridge::close()`).
- Sequence in `Drop`:
  1. Close stdin (signals EOF to Ruby).
  2. `child.try_wait()` — if already exited, done.
  3. `child.kill()` — only if still running after a short grace period.

---

## 6. Partial writes and line framing

**Problem.** JSON-RPC over stdio relies on newline framing.  If the Rust
`BufWriter` is not flushed after each `writeln!`, multiple requests may be
coalesced into one `write` syscall.  Ruby's `each_line` handles this correctly
(it buffers internally), but if you use `IO#read_nonblock` or `IO#gets` on the
Ruby side without buffering, you may receive a partial line.

**Rule.**  Always call `writer.flush()` immediately after `writeln!(writer, …)`.
The `BufWriter` wraps `ChildStdin` whose kernel buffer is already large enough;
the flush ensures the data is handed to the OS promptly.

---

## 7. Reader thread and response ordering

**Problem.** JSON-RPC IDs exist precisely because responses may arrive
out-of-order.  However, the current implementation uses a
`HashMap<id, SyncSender>` which is correct only if the reader thread is the
*sole* consumer of stdout.  Spawning a second reader thread would cause a race.

**Rule.**  There must be exactly one reader thread per child process.  All
in-flight calls share the `PendingMap` and wait on their own `SyncSender`.

---

## 8. Large payloads and pipe buffer limits

**Problem.** Linux pipe buffers are 64 KB by default.  If a single JSON-RPC
response exceeds 64 KB and the Rust reader thread is not draining stdout fast
enough, Ruby's `puts` will block, stalling the entire sidecar.

**Mitigation.**  The reader thread runs independently of call sites, so it
drains the pipe continuously.  For very large payloads (> 1 MB), consider
switching to a file/socket transport or streaming the response in chunks.
