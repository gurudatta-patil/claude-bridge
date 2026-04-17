# Ruby sidecar test fixtures

Test fixtures for the Ruby sidecar used in TypeScript ↔ Ruby integration tests.

## test-child.rb

A minimal sidecar implementing test methods:

| Method | Params | Result | Notes |
|--------|--------|--------|-------|
| `echo` | `{"msg": string}` | `{"msg": string}` | Passes msg through unchanged |
| `add` | `{"a": number, "b": number}` | `{"sum": number}` | Basic arithmetic |
| `raise_error` | `{}` | — | Always raises `RuntimeError` with a backtrace |

## File to create

`languages/ruby/tests/test-child.rb` — implement before running ts-ruby.test.ts.
