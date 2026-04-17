# Edge Cases — Go → Node.js Bridge

## 1. Node.js async event loop: concurrency is free

Node.js runs on a single-threaded event loop with native async/await. Every handler
in the sidecar is implicitly non-blocking as long as it uses `async` functions and
does not call synchronous blocking APIs (e.g. `fs.readFileSync` on large files,
`child_process.execSync`). This means the sidecar can handle multiple in-flight
requests without any threads or mutexes — it receives line N+1 before the promise
from line N resolves, and each `process.stdout.write` call is fire-and-forget (the
event loop serialises them internally).

**Actionable rule:** always `await` I/O inside handlers. Never use `*Sync` variants
in production sidecars.

## 2. readline 'close' event — the most reliable stdin-EOF watchdog

When the Go parent closes its `stdin` pipe (or exits), the OS closes the read end of
the child's stdin. Node's `readline.Interface` detects this and emits `'close'`. This
is more reliable than polling because:

- It fires even if the parent crashes (the kernel closes the fd).
- It does not require a sentinel message over the wire.
- It works identically on Linux, macOS, and Windows.

```js
rl.on('close', () => process.exit(0));
```

Do **not** use `process.stdin.on('end', ...)` alone — `readline` may buffer and not
propagate the `end` event immediately.

## 3. process.stdout highWaterMark and backpressure

`process.stdout` is a `net.Socket` backed stream. Its default highWaterMark is 16 KiB.
For payloads larger than that, `process.stdout.write(data)` may return `false`,
signalling that the kernel write buffer is full. Ignoring this causes silent data loss
under heavy load.

**Safe pattern for large writes:**
```js
function writeResponse(json) {
  const line = json + '\n';
  if (!process.stdout.write(line)) {
    // Wait for 'drain' before sending more.
    process.stdout.once('drain', () => { /* resume reading */ });
  }
}
```

For the common RPC pattern (request → response cadence) backpressure is rarely hit in
practice, but it becomes relevant when streaming large results (e.g. returning a 1 MB
base-64 blob).

## 4. Windows: node.exe path detection

On Windows the executable is `node.exe`, not `node`. The `LookupNode()` helper in
`node_lookup.go` tries both names via `exec.LookPath`. Additionally:

- Node may be installed via `nvm-windows`, `fnm`, or `volta` — these add shim
  directories to `PATH` that may not be visible to child processes spawned from Go
  unless the parent inherits the full `PATH`.
- The Go `exec.Command` on Windows requires the full path or a PATH-resolvable name;
  using `cmd /C node` is an anti-pattern because it spawns an extra shell process.

**Recommendation:** set `cmd.Env = os.Environ()` (already the default) so the child
inherits the parent's `PATH`.

## 5. ES module vs CommonJS

Node.js supports two module systems. The sidecar template uses **CommonJS** (`require`)
which works in all Node versions (10+) without any flags or file-extension magic.

If you want to use ES modules:

| Approach | How |
|---|---|
| `.mjs` extension | rename file to `sidecar.mjs`; use `import` / top-level `await` |
| `"type": "module"` in `package.json` | add `package.json` with `{"type":"module"}` next to the `.js` file |
| TypeScript + tsx | use `tsx sidecar.ts`; see `future-scope.md` |

**Pitfall:** `readline.createInterface` is identical in both systems. However dynamic
`require()` (e.g. loading plugins) does not work inside ES modules — use `import()`
instead.

## 6. Node version differences in readline

| Node version | Behaviour |
|---|---|
| 14 | `rl.on('close')` fires reliably; no `Symbol.asyncIterator` on `readline` |
| 16 | `readline/promises` module introduced (Node 17+) |
| 18 LTS | `readline.createInterface` is stable; `for await (const line of rl)` works |
| 20+ | `AbortController` support in readline; `readlineSync` removed |

The template uses the callback-based `rl.on('line')` API which is stable across **all**
supported Node versions (14 through 22+). Avoid `readline/promises` if you need to
support Node 14/16.

## 7. Graceful shutdown ordering

The correct teardown sequence from the Go side is:

1. Call `bridge.Close()` — this calls `stdin.Close()`.
2. The OS delivers EOF to the child's stdin.
3. readline emits `'close'`; the child calls `process.exit(0)`.
4. Go's `cmd.Wait()` returns (exit code 0).

If the child does not exit within a reasonable timeout, the Go side should call
`cmd.Process.Kill()` as a fallback. The current template does not implement a kill
timeout — add one for production use:

```go
done := make(chan error, 1)
go func() { done <- cmd.Wait() }()
select {
case <-done:
case <-time.After(3 * time.Second):
    _ = cmd.Process.Kill()
    <-done
}
```
