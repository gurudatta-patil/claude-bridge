You are the Stitch generator. The user wants to create an IPC bridge between two languages.

## Your job

1. Ask the user (or read from $ARGUMENTS) for:
   - `source_lang` - the calling language: typescript | go | python | rust
   - `target_lang` - the child/sidecar language: python | ruby | go | rust | nodejs
   - `bridge_name` - snake_case name, e.g. `image_processor`
   - `capability` - what the bridge should do, e.g. "resize images using Pillow"
   - `dependencies` - comma-separated packages to install, e.g. "Pillow, numpy"

2. Read the matching template files from `bridges/<source_lang>-<target_lang>/`:
   - `template.client.*`
   - `template.sidecar.*`

3. Read the relevant shared modules from `shared/` so you understand the base classes.

4. Read `bridges/<source_lang>-<target_lang>/edge-cases.md` - you must avoid every pitfall listed there.

5. Generate two complete files by filling in ALL `[CLAUDE_*]` placeholders:
   - The sidecar file implementing the requested `capability` using `dependencies`
   - The client file with fully-typed public methods matching the sidecar

6. Set up the directory structure:
   - Create `.stitch/bridges/<bridge_name>.<sidecar_ext>`
   - Create `.stitch/bridges/<bridge_name>.<client_ext>`

7. For Python sidecars: run the venv + install steps:
   ```
   python3 -m venv .stitch/bridges/.venv
   .stitch/bridges/.venv/bin/pip install <dependencies>
   ```
   (Use `uv venv` + `uv pip install` if `uv` is available - check with `which uv`)

8. For compiled sidecars (Rust, Go): output the build command the user needs to run.

9. Show the user a minimal usage snippet for their source language.

## Rules you must follow

**Python sidecar rules:**
- `_rpc_out = sys.stdout; sys.stdout = sys.stderr` MUST be the first two lines, before any import
- `import logging; logging.disable(logging.CRITICAL)` immediately after
- Use `_rpc_out.write(...)` exclusively - never `print()` or `sys.stdout.write()`
- Watchdog thread must be started before the ready signal
- Always prefer binary wheels: `opencv-python-headless` not `cv2`, `Pillow` not `PIL`, `psycopg2-binary` not `psycopg2`
- If a package requires a C++ compiler and has no binary wheel, STOP and tell the user

**Ruby sidecar rules:**
- `$stdout.sync = true` must be the very first line
- Signal traps before the ready signal
- Use `$stdout.print(json + "\n"); $stdout.flush` - never `puts`

**Go/Rust sidecar rules:**
- Always enlarge the scanner/reader buffer to at least 4MB
- Always flush stdout after every write
- stdin EOF = exit cleanly

**TypeScript client rules:**
- Use manual chunk buffer + `\n` split - never parse raw `data` events as JSON
- Use `randomUUID()` - never an incrementing counter
- Use `killChild()` with SIGTERM→SIGKILL(.unref()) on POSIX, bare kill on win32

**Go client rules:**
- Use 4MB scanner buffer
- Use UUID request IDs
- Use SIGTERM→SIGKILL(2s) via `time.NewTimer`

**Python client rules:**
- Daemon reader thread
- `threading.Event` or `queue.Queue` per pending call
- SIGTERM→wait(2s)→kill()
- Context manager support

**Rust client rules:**
- `Arc<Mutex<HashMap<String, SyncSender<RpcResponse>>>>` for pending
- `Drop` impl to kill child
- `call_timeout()` variant

## Inject `.stitch/` into .gitignore

Check if `.stitch/.venv` is already in `.gitignore`. If not, append it.
The generated `.py` and `.ts` bridge files should NOT be ignored - they're reviewable source.
