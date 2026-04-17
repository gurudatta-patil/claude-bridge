# Rust sidecar test fixtures

Test fixtures for the Rust sidecar binary used in TypeScript ↔ Rust integration tests.

## test-child-rs

A minimal Rust binary (`src/main.rs` + `Cargo.toml`) implementing test methods:

| Method | Params | Result | Notes |
|--------|--------|--------|-------|
| `echo` | `{"msg": string}` | `{"msg": string}` | Passes msg through unchanged |
| `add` | `{"a": i64, "b": i64}` | `{"sum": i64}` | Basic arithmetic |
| `raise_error` | `{}` | error object | Returns JSON-RPC error |

## Files to create

- `languages/rust/tests/test-child/Cargo.toml`
- `languages/rust/tests/test-child/src/main.rs`

Build: `cargo build --release` before running ts-rust.test.ts.
