# Go sidecar test fixtures

Test fixtures for the Go sidecar binary used in TypeScript ↔ Go integration tests.

## test-child-go

A minimal Go binary implementing test methods:

| Method | Params | Result | Notes |
|--------|--------|--------|-------|
| `echo` | `{"msg": string}` | `{"msg": string}` | Passes msg through unchanged |
| `add` | `{"a": int, "b": int}` | `{"sum": int}` | Basic arithmetic |
| `raise_error` | `{}` | error object | Returns JSON-RPC error |

## Files to create

- `languages/go/tests/test-child/main.go`
- `languages/go/tests/test-child/go.mod`

Build: `go build -o test-bridge-go .` before running ts-go.test.ts.
