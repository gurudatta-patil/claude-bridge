# Python → Node.js Bridge

A Stitch bridge that lets Python applications call functions implemented in a Node.js sidecar process. Communication uses newline-delimited JSON-RPC over stdin/stdout — no HTTP server, no ports, no network configuration.

## How it works

```
Python process                    Node.js sidecar
─────────────────                 ───────────────────────
NodeBridge.call("add", ...)  ──►  handlers.add({ a, b })
                             ◄──  { id, result: { sum } }
```

1. Python spawns the Node.js script as a child process.
2. Node.js writes `{"ready":true}` on stdout once initialised.
3. Python sends `{"id":"<uuid>","method":"add","params":{"a":1,"b":2}}` on stdin.
4. Node.js dispatches to the matching handler, writes `{"id":"<uuid>","result":{"sum":3}}` back.
5. Python unblocks the waiting thread and returns the result.

The bridge is thread-safe: multiple Python threads can issue concurrent calls; each call is matched by its UUID.

## Prerequisites

- **Python 3.9+**
- **Node.js 18+** (CommonJS, no extra npm packages required)

## Quick start

### 1. Copy the templates

```
cp bridges/python-nodejs/template.client.py  myproject/node_bridge.py
cp bridges/python-nodejs/template.sidecar.js myproject/sidecar.js
```

### 2. Add handlers to `sidecar.js`

Open `sidecar.js` and add methods inside the `handlers` object:

```js
const handlers = {
  __ping__: async () => ({ pong: true, pid: process.pid }),

  greet: async ({ name }) => ({ message: `Hello, ${name}!` }),

  add: async ({ a, b }) => ({ sum: a + b }),
};
```

### 3. Add typed methods to `node_bridge.py` (optional)

Below the `# [CLAUDE_HANDLER_FUNCTIONS_HERE]` marker, add convenience wrappers:

```python
def greet(self, name: str) -> str:
    result = self._call("greet", {"name": name})
    return result["message"]

def add(self, a: float, b: float) -> float:
    return self._call("add", {"a": a, "b": b})["sum"]
```

### 4. Use the bridge in Python

```python
from node_bridge import NodeBridge

with NodeBridge(["node", "sidecar.js"]) as bridge:
    print(bridge.call("greet", {"name": "World"}))
    # → {"message": "Hello, World!"}

    print(bridge.call("add", {"a": 1, "b": 2}))
    # → {"sum": 3}
```

## Example: full round-trip

```python
import sys
sys.path.insert(0, "../../shared/python")
from bridge_client import BridgeClientBase

class NodeBridge(BridgeClientBase):
    def __init__(self, script="sidecar.js"):
        super().__init__(["node", script])

    def ping(self):
        return self._call("__ping__")

with NodeBridge() as b:
    b.start()
    print(b.ping())   # {'pong': True, 'pid': 12345}
```

## Template slots

| File | Slot | Purpose |
|---|---|---|
| `template.client.py` | `# [CLAUDE_HANDLER_FUNCTIONS_HERE]` | Add typed Python wrapper methods |
| `template.sidecar.js` | `handlers` object | Add async Node.js handler functions |

## Running the tests

```bash
# Smoke test (standalone, no pytest needed)
python bridges/python-nodejs/tests/test-client.py

# Full pytest suite
pytest bridges/python-nodejs/tests/python-nodejs_test.py -v
```

## Error handling

Errors thrown inside a Node.js handler are serialised and re-raised in Python as `BridgeError`:

```python
from bridge_client import BridgeError

try:
    bridge.call("raise_error", {})
except BridgeError as e:
    print(e.code, e.message)   # -32000  deliberate test error
```

Unknown methods raise `BridgeError` with code `-32601`.

## Timeouts

| Parameter | Default | Description |
|---|---|---|
| `ready_timeout` | 10 s | Max wait for `{"ready":true}` on startup |
| `call_timeout` | 30 s | Max wait per individual RPC call |

Override at construction time:

```python
bridge = NodeBridge(["node", "sidecar.js"], ready_timeout=5.0, call_timeout=10.0)
```
