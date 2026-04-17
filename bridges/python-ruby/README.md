# Stitch — Python → Ruby

Seamless cross-language IPC: a Python process spawns a Ruby child and
communicates with it over **newline-delimited JSON-RPC on stdio**.

---

## Directory layout

```
bridges/python-ruby/
├── template.client.py      # Copy-paste Python client class (RubyBridge)
├── template.sidecar.rb     # Copy-paste Ruby sidecar skeleton
├── edge-cases.md           # Python↔Ruby specific gotchas
├── future-scope.md         # Ideas for future enhancements
├── README.md               # This file
└── tests/
    ├── test-child.rb       # Concrete Ruby sidecar used by the test suite
    ├── test-client.py      # Interactive smoke-test script
    └── python-ruby_test.py # pytest / unittest test suite
```

---

## Protocol summary

```
Python (parent)                         Ruby (child)
───────────────                         ────────────
                     spawn child
                  ─────────────────►
                  ◄─────────────────
               {"ready":true}\n

{"id":"<uuid>","method":"m","params":{}} ─►
                  ◄─ {"id":"<uuid>","result":<value>}\n
               or ◄─ {"id":"<uuid>","error":{"code":-32000,"message":"..."}}\n
```

All messages are UTF-8, newline-terminated JSON on stdin/stdout.  Neither side
uses stderr for the protocol — stderr is available for out-of-band logging.

---

## Quick start

### 1. Copy the templates

```bash
cp bridges/python-ruby/template.client.py  myproject/ruby_bridge.py
cp bridges/python-ruby/template.sidecar.rb myproject/sidecar.rb
```

### 2. Add your methods to the Ruby sidecar

Open `sidecar.rb` and fill in `METHODS`:

```ruby
METHODS = {
  'greet' => ->(params) { "Hello, #{params.fetch('name')}!" },
  'add'   => ->(params) { params['a'] + params['b'] },
}.freeze
```

### 3. Use `RubyBridge` in Python

```python
from ruby_bridge import RubyBridge

with RubyBridge(["ruby", "sidecar.rb"]) as bridge:
    print(bridge.call("greet", {"name": "World"}))   # → "Hello, World!"
    print(bridge.call("add",   {"a": 1, "b": 41}))   # → 42
```

---

## `RubyBridge` API

```python
class RubyBridge:
    def __init__(
        self,
        cmd: list[str],          # e.g. ["ruby", "sidecar.rb"]
        ready_timeout: float = 10.0,
        call_timeout:  float = 30.0,
        env: dict | None = None,
    ) -> None: ...

    def call(self, method: str, params: dict | None = None) -> Any:
        """Send a request; block until response. Thread-safe."""

    def close(self, force: bool = False) -> None:
        """SIGTERM → wait 2 s → SIGKILL."""

    # Context manager support
    def __enter__(self) -> "RubyBridge": ...
    def __exit__(self, *_) -> None: ...
```

`BridgeError` is raised when the sidecar returns an `{"error":...}` object.
`TimeoutError` is raised when no response arrives within `call_timeout`.

---

## Running the tests

```bash
# Interactive smoke-test (prints pass/fail to stdout)
python bridges/python-ruby/tests/test-client.py

# Full test suite via pytest
pytest bridges/python-ruby/tests/python-ruby_test.py -v

# or via unittest
python -m unittest bridges/python-ruby/tests/python-ruby_test.py -v
```

Requirements: Python 3.9+ · Ruby 2.7+ (no gems required for the test child)

---

## Ruby sidecar rules

| Rule | Why |
|------|-----|
| `$stdout.sync = true` as the **very first line** | Without it Ruby buffers stdout in 8 KB blocks; the Python reader thread hangs indefinitely |
| Write responses with `$stdout.print(json + "\n"); $stdout.flush` | Explicit flush is redundant when `sync=true` but harmless — keep it for clarity |
| Emit `{"ready":true}` **before** entering the request loop | Python's `__init__` blocks until this line arrives |
| Exit on stdin EOF | The parent process may die silently; `$stdin.gets` returning `nil` is the signal |
| Trap `INT` and `TERM` for clean shutdown | Allows `SIGTERM` from `RubyBridge.close()` to be handled gracefully |

---

## Key implementation notes

### Thread model (Python side)

```
Main thread         Reader daemon thread      Stderr drain thread
──────────          ────────────────────      ───────────────────
spawn Ruby    ───►  loop: readline()          loop: readline()
wait ready          if ready → set event      discard
                    if response → put(queue)

call("add",…) ──►  (queue created, request written to stdin)
queue.get() ──────◄ put_nowait(response)
return result
```

### Why `queue.Queue` per call?

Each in-flight call registers a `Queue(maxsize=1)` keyed by its UUID.  The
reader thread routes responses by ID — concurrent calls from multiple threads
never interfere.

### Signal handling

Python only delivers signals to the **main thread**.  `_install_signal_handlers`
checks this and skips installation when constructed from a worker thread.  If
you construct `RubyBridge` inside a thread, call `bridge.close()` manually in
your `finally` block.

---

## Common pitfalls

See [edge-cases.md](edge-cases.md) for the full list.  The top three:

1. **Never** block the main thread on `proc.stdout.read()` — use the daemon
   reader thread.
2. **Always** drain stderr in a background thread; a full stderr pipe will
   block Ruby writes.
3. `proc.stdout.readline()` returns **bytes** — decode with
   `.decode("utf-8", errors="replace")`.

---

## Future ideas

See [future-scope.md](future-scope.md) — highlights include async client,
streaming responses, connection pooling, and MessagePack transport.
