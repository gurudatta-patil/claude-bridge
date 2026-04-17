# Python sidecar test fixtures

Test fixtures for the Python sidecar used in TypeScript ↔ Python integration tests.

## test-child.py

A minimal sidecar implementing a few test methods:

| Method | Params | Result | Notes |
|--------|--------|--------|-------|
| `echo` | `{"msg": string}` | `{"msg": string}` | Passes msg through unchanged |
| `add` | `{"a": number, "b": number}` | `{"sum": number}` | Basic arithmetic |
| `raise_error` | `{}` | — | Always raises `ValueError("deliberate test error")` |
| `echo_b64` | `{"data_b64": string}` | `{"data_b64": string}` | Round-trips Base64 payload |
| `slow` | `{"ms": number}` | `{"done": true}` | Sleeps for `ms` milliseconds — used for concurrency tests |

## File to create

`languages/python/tests/test-child.py` — implement before running ts-python.test.ts.
