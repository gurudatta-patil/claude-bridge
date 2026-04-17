# Language Rules — Python (Sidecar / Target)

Python is always the **target** (child process) in a bridge. It receives JSON-RPC requests and returns results.

---

## Environment

| Concern | Rule |
|---------|------|
| Isolation | Always run inside `.ghost-bridge/.venv`. Never use global `python`. |
| Executable | `bin/python` (POSIX) · `Scripts/python.exe` (Windows) |
| Version | Minimum Python 3.9 (for `str | None` union shorthand) |
| Installer | `uv pip install` if `uv` present, else `python -m pip install` |

---

## Startup Contract

1. Imports complete.
2. Write `{"ready": true}` to stdout and flush — **before entering the loop**.
3. Block on `sys.stdin.readline()`.

---

## Shutdown / Signal Rules

| Signal / Event | Required behaviour |
|---------------|-------------------|
| stdin EOF | `sys.exit(0)` immediately (parent died) |
| `SIGTERM` | Flush stdout, `sys.exit(0)` |
| `SIGINT` | Flush stdout, `sys.exit(0)` |
| `sys.exit` from watchdog | No cleanup needed — watchdog is daemon thread |

### Watchdog thread (mandatory)

```python
import threading, sys

def _watchdog():
    while sys.stdin.read(1):
        pass
    sys.exit(0)

threading.Thread(target=_watchdog, daemon=True).start()
```

---

## stdout Discipline

- **Only** write newline-delimited JSON to stdout.
- Third-party libraries that print to stdout must be silenced before the ready signal:
  ```python
  import sys
  _stdout = sys.stdout
  sys.stdout = sys.stderr      # redirect noisy lib prints to stderr
  # ... imports ...
  sys.stdout = _stdout         # restore for JSON-RPC loop
  ```

---

## Error Format

```python
{
    "id": req.get("id"),
    "error": {
        "message": str(e),
        "traceback": traceback.format_exc()
    }
}
```

Never let an exception escape the main loop unhandled.

---

## Binary Data

- MVP: Base64-encode all binary return values.
- Key name convention: `"data_b64"` for raw binary, `"image_b64"` for images.
- V2: pass raw bytes on fd[3].
