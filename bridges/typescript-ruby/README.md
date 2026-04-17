# Stitch: TypeScript → Ruby

Call Ruby code from TypeScript (or any Node.js process) over a type-safe,
newline-delimited JSON-RPC channel on stdin/stdout. No network sockets, no
serialisation libraries beyond Ruby's stdlib `json`, no shared memory.

---

## When to use this bridge

| Situation | Recommendation |
|---|---|
| You have existing Ruby business logic (gems, Rails models, custom DSLs) | Use this bridge |
| You need a sandboxed Ruby process with automatic cleanup when the parent dies | Use this bridge |
| You want true parallelism on CPU-bound Ruby work | Consider JRuby variant (see `future-scope.md`) |
| Your Ruby code uses async I/O at scale | Consider `async` gem (see `future-scope.md`) |
| You just need a simple script with no gems | Use this bridge as-is |

---

## Quick Start

### 1. Write a sidecar

Copy `template.sidecar.rb`, replace the `[CLAUDE_*]` placeholders, and add
your handlers to the `HANDLERS` hash:

```ruby
HANDLERS = {
  'greet' => ->(params) { { message: "Hello, #{params['name']}!" } },
}.freeze
```

### 2. Instantiate the client

Copy `template.client.ts`, replace the `[CLAUDE_*]` placeholders, then:

```typescript
import { MyBridgeClient } from './my-bridge.client';

const client = new MyBridgeClient({ scriptPath: './my-sidecar.rb' });
await client.start();

const result = await client.call('greet', { name: 'World' });
console.log(result.message); // "Hello, World!"

await client.stop();
```

### 3. Run the tests

```bash
# From the repo root (requires Node ≥ 18, ruby ≥ 3.0)
pnpm vitest run bridges/typescript-ruby/tests/ts-ruby.test.ts
```

---

## Protocol Summary

All messages are newline-delimited JSON on stdin/stdout.

| Direction | Shape |
|---|---|
| Sidecar → Parent (startup) | `{"ready":true}` |
| Parent → Sidecar (call) | `{"id":"<uuid>","method":"name","params":{...}}` |
| Sidecar → Parent (success) | `{"id":"<uuid>","result":{...}}` |
| Sidecar → Parent (error) | `{"id":"<uuid>","error":{"message":"...","backtrace":"..."}}` |

---

## File Reference

| File | Purpose |
|---|---|
| `template.sidecar.rb` | Ruby sidecar template with `[CLAUDE_*]` placeholders |
| `template.client.ts` | TypeScript client template with `[CLAUDE_*]` placeholders |
| `tests/test-child.rb` | Runnable Ruby sidecar used by the test suite |
| `tests/ts-ruby.test.ts` | Vitest integration tests (round-trip, concurrency, errors, Base64, EOF defence) |
| `edge-cases.md` | Ruby-specific gotchas: GVL, Bundler, encoding, Windows, exception hierarchy |
| `future-scope.md` | Roadmap: Sorbet→TS types, async gem, JRuby, Zeitwerk hot reload |
| `README.md` | This file |

---

## Requirements

| Dependency | Version |
|---|---|
| Node.js | ≥ 18 (for `crypto.randomUUID`) |
| TypeScript | ≥ 5.0 |
| Vitest | ≥ 1.0 (dev dependency, tests only) |
| Ruby | ≥ 3.0 (for `e.full_message`; 2.7 works but `full_message` was added in 2.5) |
| Bundler | ≥ 2.0 (only if sidecar uses non-stdlib gems) |

No Ruby gems beyond stdlib are required for the base bridge. The test sidecar
uses only `json` and `base64`, both part of Ruby's standard library.

---

## Security Notes

- The sidecar inherits the parent process's environment. Avoid passing secrets
  via environment variables unless your threat model allows it.
- The sidecar's stdin is connected directly to the TypeScript parent — do not
  expose the child process's stdin to untrusted input.
- Error responses include `e.full_message` (which contains a backtrace). Strip
  backtraces before forwarding errors to untrusted clients in production.
