# Edge Cases – TypeScript → Python Bridge

This document catalogues issues that are **specific to bridging TypeScript (Node.js) with a Python subprocess over stdio JSON-RPC**. Generic IPC edge cases (malformed JSON, race conditions, etc.) are covered in the top-level protocol specification.

---

## 1. Python GIL and Concurrent Requests

### The issue
Python's Global Interpreter Lock (GIL) means only one OS thread executes Python bytecode at a time. If the sidecar's main loop is CPU-bound (e.g. numpy matrix maths, pure-Python parsing), concurrent requests from the TypeScript parent **do not actually run in parallel** — they are serialised by the GIL.

### When it matters
- CPU-heavy handlers (image processing, data transforms).
- Not a problem for I/O-bound work: `time.sleep`, network calls, and most C-extension I/O (numpy, PIL file I/O) **release the GIL** and therefore overlap naturally.

### Mitigations
- Use `concurrent.futures.ProcessPoolExecutor` to offload CPU work to separate processes (each has its own GIL).
- Use `multiprocessing.pool.ThreadPool` with C-extension functions that release the GIL.
- Restructure the sidecar as an asyncio event loop (see Future Scope) — `asyncio.to_thread` will still hit the GIL for pure-Python work, but composes cleanly with async I/O.
- For the simple synchronous template, document the GIL limitation explicitly so callers don't expect true parallelism.

---

## 2. `asyncio` vs. `threading` in the Sidecar

### The issue
The template uses a blocking `for raw_line in sys.stdin` loop, which runs entirely on the main thread. This is the simplest model but has two consequences:
- A slow handler blocks the loop from reading the next request.
- There is no built-in way to run async library code (e.g. `aiohttp`, `asyncpg`).

### Threading model
Spawning a `threading.Thread` per request is fine for I/O-bound handlers but increases memory usage and risks data races on shared state.

### asyncio model
Rewriting `main()` around `asyncio.run()` with `loop.run_in_executor(None, handler)` gives proper concurrency for I/O-bound work, but:
- Requires Python ≥ 3.7.
- Line-reading from stdin must use `asyncio.StreamReader` (not the blocking iterator).
- `asyncio.to_thread` (Python 3.9+) is cleaner than `run_in_executor`.

### Recommendation
Use the blocking template for simple sidecars. Provide an async variant (see Future Scope) for sidecars that call async libraries or need true concurrent I/O.

---

## 3. Windows Virtual-Environment Path Differences

### The issue
On POSIX the venv executable lives at `.venv/bin/python`. On Windows it is `.venv/Scripts/python.exe`. The TypeScript `resolvePython()` helper **must** branch on `os.platform()`.

```ts
const venvBin = platform() === "win32"
  ? path.join(dir, ".venv", "Scripts", "python.exe")
  : path.join(dir, ".venv", "bin", "python");
```

### Additional Windows quirks
- `SIGTERM` is not a real signal on Windows; `child.kill()` sends `SIGKILL`-equivalent (`TerminateProcess`). The `killChild()` helper must skip the SIGTERM→SIGKILL escalation on win32.
- Python on Windows may default to UTF-8 mode depending on the `PYTHONUTF8` env var and the console code page. Set `PYTHONUTF8=1` or open stdin/stdout with `encoding="utf-8"` explicitly.
- Path separators in error tracebacks will use `\` on Windows; test assertions that inspect tracebacks should not hard-code `/`.

---

## 4. Large Payload Performance and Base64 Overhead

### The issue
Base64 encoding inflates binary data by ~33 %. A 10 MB binary payload becomes ~13.3 MB of ASCII JSON. For each hop:
1. TypeScript serialises to JSON string (UTF-8 bytes on the pipe).
2. Python deserialises the JSON, then `base64.b64decode()` reconstructs the binary.

For a round-trip both sides pay the cost twice.

### Measured overhead (approximate)
| Payload size | JSON size after b64 | Round-trip latency (local pipe) |
|---|---|---|
| 64 KB | ~88 KB | < 5 ms |
| 1 MB | ~1.4 MB | ~15–30 ms |
| 10 MB | ~14 MB | ~150–300 ms |
| 100 MB | ~140 MB | > 1 s — avoid |

### Mitigations
- Keep individual payloads below 1 MB per call; batch processing server-side.
- Use a separate binary file descriptor (fd[3]) for large blobs (see Future Scope).
- Compress before encoding: `zlib.compress` + base64 can cut size by 50–80 % for typical data.
- Stream large results as multiple smaller RPC responses using a streaming protocol extension.

---

## 5. Python Startup Latency (~200 ms Cold Start)

### The issue
Importing the CPython interpreter, executing `sitecustomize.py`, and importing standard-library modules takes ~150–250 ms on a typical laptop. With heavy imports (numpy, pandas, PIL) this can exceed 1–2 s.

### Manifestation
The TypeScript `start()` method awaits `{"ready": true}`. If this timeout is too short the bridge will fail on the first call even though the sidecar is healthy.

### Mitigations
- **Keep-alive pool**: start N Python sidecars at application boot; route calls round-robin. Amortises the startup cost across all calls.
- **Lazy imports**: import heavy libraries inside handler functions (first call is slow; subsequent calls hit the module cache).
- **Frozen application**: use `PyInstaller` or `cx_Freeze` to produce a pre-compiled executable that skips most of the import phase.
- **`PYTHONSTARTUPTIME` env var** (Python 3.11+): use `-X importtime` during development to identify slow imports.
- **Set a generous ready timeout** (e.g. 15 s) in tests and production, with a clear error message if it fires.

---

## 6. `numpy` / `PIL` stdout Contamination

### The issue
Some third-party libraries write directly to `sys.stdout` (or to the C-level `stdout` file descriptor) during import or first use:
- **numpy** (older builds): prints deprecation warnings or version banners to stdout on some platforms.
- **PIL / Pillow**: can print codec loading messages.
- **OpenCV (`cv2`)**: prints FFMPEG/backend discovery messages to fd 1.
- **matplotlib**: prints font cache rebuilding messages.

Because the RPC channel uses fd 1, **any of these lines will corrupt the JSON stream**, causing the TypeScript parent to receive a `JSON.parse` failure.

### The template's defence
The sidecar redirects `sys.stdout → sys.stderr` **before** any third-party import. This neutralises Python-level `print()` calls.

### What the redirect does NOT cover
- C-extension code that writes directly to the underlying file descriptor 1 (`write(1, ...)` syscall), bypassing `sys.stdout` entirely. OpenCV and some FFMPEG bindings do this.

### Mitigations for fd-1 contamination
```python
import os, sys

# After the sys.stdout redirect, also point fd 1 at stderr at the OS level:
_rpc_out_fd = os.dup(1)          # save a dup of the real stdout fd
os.dup2(2, 1)                    # redirect fd 1 → fd 2 (stderr)
_rpc_out = os.fdopen(_rpc_out_fd, "w", buffering=1)  # write RPC here
```
This ensures even C-level writes to fd 1 go to stderr. **Apply this technique when importing OpenCV or FFMPEG-backed libraries.**

---

## 7. `sys.stdout` Buffering Modes

### The issue
Python's stdout buffering behaviour differs by context:

| Scenario | Default buffering |
|---|---|
| Interactive terminal | Line-buffered |
| Pipe / subprocess | **Fully-buffered** (8 KB block) |
| `python -u` flag | Unbuffered (binary) |
| `PYTHONUNBUFFERED=1` | Unbuffered |

When the sidecar runs as a subprocess, `sys.stdout` defaults to **full buffering**. This means `_rpc_out.write(line)` may not flush until 8 KB accumulate, causing the TypeScript parent to wait indefinitely for a response.

### The template's defence
Every `_send()` call ends with `_rpc_out.flush()`. This is the minimum required fix and works correctly regardless of the buffering mode.

### Alternative: open in line-buffered mode
```python
import io, os
_rpc_out = io.TextIOWrapper(
    os.fdopen(os.dup(1), "wb"),
    encoding="utf-8",
    line_buffering=True,   # flush on every \n
    write_through=False,
)
```
Line-buffered mode is slightly more efficient than calling `flush()` manually because it avoids the Python function-call overhead on every response.

### Binary vs text mode
Opening `_rpc_out` in binary mode (`"wb"`) and encoding manually gives the most control over buffering and avoids platform newline translation (important on Windows where text mode converts `\n` → `\r\n`). The template uses text mode with explicit `flush()` for readability; switch to binary + manual encode if you observe `\r\n` corruption on Windows.
