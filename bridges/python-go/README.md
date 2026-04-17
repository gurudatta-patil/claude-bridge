# Stitch — Python → Go

A minimal, production-ready bridge that lets a **Python process** call methods
implemented in a **compiled Go binary** over newline-delimited JSON-RPC on
stdio.

```
Python (source/client)          Go binary (target/sidecar)
──────────────────────          ──────────────────────────
GoBridge.call("add", ...)  ──►  handleAdd(params)
                           ◄──  {"id":"…","result":42}
```

No network sockets, no serialisation frameworks, no shared memory — just pipes
and JSON.

---

## Repository layout

```
bridges/python-go/
├── template.client.py          # GoBridge Python class (copy & use directly)
├── template.sidecar/
│   ├── main.go                 # Go sidecar template with TODO markers
│   └── go.mod
├── tests/
│   ├── test-child/
│   │   ├── main.go             # Real Go sidecar: echo, add, raise_error, …
│   │   └── go.mod
│   ├── test-client.py          # Manual smoke-test script
│   └── python-go_test.py       # pytest test suite
├── edge-cases.md               # Python→Go-specific pitfalls
├── future-scope.md             # Roadmap ideas
└── README.md                   # This file
```

---

## Quick start

### 1. Build the Go sidecar

```bash
cd bridges/python-go/tests/test-child
go build -o ../test-child-bin .
```

On Windows the output name should be `test-child-bin.exe`.

### 2. Run the smoke-test client

```bash
python bridges/python-go/tests/test-client.py
```

Expected output:

```
────────────────────────────────────────────────────────────
  echo
────────────────────────────────────────────────────────────
echo result: 'hello, Go!'
...
✓ All smoke tests passed.
```

### 3. Run the full pytest suite

```bash
pytest bridges/python-go/tests/python-go_test.py -v
```

---

## Protocol

All messages are **single-line JSON** delimited by `\n`.

| Direction | Shape |
|-----------|-------|
| Go → Python (startup) | `{"ready":true}` |
| Python → Go (request) | `{"id":"<uuid>","method":"<name>","params":<any>}` |
| Go → Python (success) | `{"id":"<uuid>","result":<any>}` |
| Go → Python (error)   | `{"id":"<uuid>","error":{"code":<int>,"message":"<str>"}}` |

Closing Python's stdin pipe (`proc.stdin.close()`) signals the Go sidecar to
exit cleanly.

---

## Using `GoBridge` in your own code

```python
from template_client import GoBridge, GoBridgeError

# Option A — context manager (recommended)
with GoBridge("/path/to/your-binary") as bridge:
    result = bridge.call("my_method", {"key": "value"})

# Option B — manual lifecycle
bridge = GoBridge("/path/to/your-binary")
bridge.start()
try:
    result = bridge.call("my_method", {"key": "value"})
finally:
    bridge.stop()
```

### Building the binary from Python

```python
binary = GoBridge.build("path/to/sidecar/")   # runs `go build`
with GoBridge(binary) as bridge:
    ...
```

### Error handling

```python
from template_client import GoBridgeError

try:
    bridge.call("risky_method", {})
except GoBridgeError as e:
    print(f"Remote error {e.code}: {e.message}")
except TimeoutError:
    print("No response within the timeout window")
```

---

## Writing a Go sidecar

1. Copy `template.sidecar/` to your project.
2. Register handlers in the `handlers` map:

```go
var handlers = map[string]HandlerFunc{
    "my_method": handleMyMethod,
}

func handleMyMethod(params json.RawMessage) (interface{}, *RPCError) {
    var p struct {
        Key string `json:"key"`
    }
    if err := json.Unmarshal(params, &p); err != nil {
        return nil, &RPCError{Code: -32602, Message: err.Error()}
    }
    return p.Key + "_processed", nil
}
```

3. Increase the scanner buffer if your payloads exceed 64 KB (see the TODO
   comment in `main.go` and `edge-cases.md §2`).

4. Build: `go build -o my-sidecar .`

---

## Key design decisions

| Decision | Rationale |
|----------|-----------|
| stdio over TCP | No port allocation, works on restricted hosts, firewall-transparent |
| `{"ready":true}` handshake | Prevents the Python caller from sending requests before the Go runtime is initialised |
| `uuid.uuid4()` request IDs | Allows concurrent calls from multiple Python threads on a single bridge instance |
| `bufsize=0` in Popen | Avoids Windows pipe-buffering stalls |
| Daemon reader thread | Python process can exit even if `stop()` is not called |
| `json.Number` in Go | Prevents float64 precision loss for large integers |

---

## Edge cases

See [`edge-cases.md`](edge-cases.md) for detailed coverage of:

- Scanner 64 KB buffer limit
- Windows pipe buffering
- `json.Number` vs `float64`
- Goroutine cleanup
- Compile step requirements

---

## Future scope

See [`future-scope.md`](future-scope.md) for roadmap ideas including:

- `context.Context` timeout propagation
- Streaming / server-sent events
- `go generate` for Python type stubs
- Automatic re-spawn on crash

---

## Requirements

| Tool | Minimum version |
|------|----------------|
| Python | 3.8 |
| Go | 1.21 |
| pytest | 7.0 (tests only) |

No third-party Python packages are required; the bridge uses only the standard
library (`subprocess`, `threading`, `json`, `uuid`).
