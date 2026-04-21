# Edge Cases - Go → Rust Bridge

## 1. JSON number type coercion: Go float64 vs Rust i64/f64

Go's `encoding/json` unmarshals all JSON numbers into `float64` by default when
the target type is `interface{}` or `map[string]any`. This means that when Go
sends `{"a": 42}`, the Rust sidecar receives the value as a JSON number, and
you must choose how to extract it.

**Safe pattern in Rust handlers:**

```rust
// Use as_f64() when the Go caller may send either integers or floats.
let a = params["a"].as_f64().ok_or("missing param: a")?;

// Use as_i64() only when you are certain the caller always sends integers
// AND the JSON number has no decimal point.  42 works; 42.0 does NOT
// decode via as_i64() in serde_json.
let n = params["n"].as_i64().ok_or("missing param: n")?;
```

**Safe pattern in Go callers:**

```go
// Explicit float avoids ambiguity.
b.Call("compute", map[string]any{"value": float64(n)})

// Or use json.Number if you need lossless integer semantics:
// Encode with a custom struct and `json.Number` field type.
```

**Gotcha:** Large integers (> 2^53) cannot be represented exactly as float64.
If you need to pass 64-bit integers, encode them as strings and parse on the
Rust side with `str.parse::<i64>()`.

---

## 2. Large payload limits and the 4 MiB scanner buffer

The Go scanner in `RustBridge` is configured with a 4 MiB per-line buffer
(`scannerBufSize = 4 * 1024 * 1024`). Any single JSON response line larger
than this will cause `bufio.ErrTooLong` and the readLoop will stop, killing
all in-flight calls.

The Rust side uses `BufWriter` which flushes after every response line, so
there is no analogous limit on the sidecar.

**Limits in practice:**

| Payload | Size after JSON encoding | Safe? |
|---|---|---|
| 1 MB binary file (base-64) | ~1.3 MB | Yes |
| 3 MB binary file (base-64) | ~4 MB | Borderline |
| 4 MB+ response | > 4 MB | Fails |

**Workaround for large responses:** Split the payload across multiple calls
(chunked transfer), or increase `scannerBufSize` before shipping. Do not set
it to an unbounded value — that opens a denial-of-service vector if the sidecar
misbehaves.

---

## 3. Panic vs error: Rust process abort vs graceful error

In Rust, `panic!` and `.unwrap()` on `None`/`Err` cause the **entire process
to abort** (not just the current request). The Go bridge detects this because
the child's stdout is closed, which terminates the readLoop and drains all
pending callers with `"child process exited"`.

`run_sidecar` does **not** catch panics per-request. If a handler can panic,
wrap it with `std::panic::catch_unwind`:

```rust
use std::panic;
use serde_json::Value;

fn safe_handler(params: Value) -> Result<Value, String> {
    panic::catch_unwind(|| risky_computation(&params))
        .map_err(|e| format!("handler panicked: {:?}", e))
        .and_then(|r| r)
}
```

Alternatively, avoid `.unwrap()` in handlers and use the `?` operator with
`ok_or("…")` / `map_err(|e| e.to_string())` to convert errors to `Err(String)`.

**Rule of thumb:** return `Err(String)` for expected failures (bad input,
not-found); let panics surface as process crashes only for unrecoverable
internal bugs.

---

## 4. Cross-platform binary paths

The Go client spawns the Rust binary via `exec.Command(binaryPath)`. The path
must be correct for the host OS.

| Platform | Cargo release output | Notes |
|---|---|---|
| Linux / macOS | `target/release/my-sidecar` | No extension |
| Windows | `target/release/my-sidecar.exe` | Must include `.exe` |

**Recommended pattern in production Go code:**

```go
import "runtime"

func sidecarPath() string {
    bin := "./sidecar/target/release/my-sidecar"
    if runtime.GOOS == "windows" {
        bin += ".exe"
    }
    return bin
}
```

For distribution, embed the sidecar binary using Go's `//go:embed` directive
and write it to a temp file on startup:

```go
//go:embed sidecar_bin/my-sidecar
var sidecarBytes []byte

func extractSidecar() (string, error) {
    f, err := os.CreateTemp("", "my-sidecar-*")
    // ... write sidecarBytes, chmod +x, return f.Name()
}
```

---

## 5. Graceful shutdown ordering

The correct teardown sequence is:

1. Call `b.Close()` — this calls `stdin.Close()`.
2. The OS delivers EOF to the Rust child's stdin.
3. The `run_sidecar` loop exits its `stdin.lock().lines()` iterator.
4. The Rust process exits with code 0.
5. Go's `cmd.Wait()` returns (exit code 0).

If the Rust process does not exit within 2 s, `killChild` sends SIGKILL.

**Do not** skip the `Close()` call — leaked child processes accumulate across
test runs and can exhaust file descriptors.

---

## 6. Single-threaded Rust sidecar and head-of-line blocking

`run_sidecar` processes requests **sequentially** in the same thread. A slow
handler blocks all subsequent requests until it returns.

If you need concurrent request handling inside the sidecar, spawn OS threads:

```rust
use std::{sync::Arc, thread};

fn handle_heavy(params: Value) -> Result<Value, String> {
    // Offload to a thread pool.  This blocks the current call until
    // the work is done, but does NOT block other concurrent calls
    // if you redesign the sidecar to use an async runtime like tokio.
    let result = thread::spawn(move || expensive_work(&params))
        .join()
        .map_err(|e| format!("thread panicked: {e:?}"))?;
    Ok(result)
}
```

For high-throughput use cases, consider switching to a Tokio-based sidecar
that processes requests concurrently. The JSON-RPC wire format is unchanged.

---

## 7. stdin/stdout buffering on Windows

On Windows, child-process stdin/stdout use synchronous I/O by default. The Go
`exec.Command` I/O pipes and the Rust `BufWriter` both work correctly, but you
may observe slightly higher latency per round-trip compared to Unix. This is
normal and unrelated to the bridge implementation.

Do not set `cmd.SysProcAttr.CreationFlags = CREATE_NEW_CONSOLE` — this detaches
the child's console, breaking stdin/stdout pipe inheritance.
