# Language Rules — TypeScript (Client / Source)

TypeScript is the **source** (parent process). It spawns the target sidecar and provides a typed async API.

---

## Environment

| Concern | Rule |
|---------|------|
| Runtime | Node.js ≥ 18 |
| Spawn mode | `child_process.spawn` with `detached: false` |
| stdio | `['pipe', 'pipe', 'inherit']` — stdin/stdout piped, stderr inherited |
| Path resolution | Always use `path.join` + `os.platform()` check. Never string-concat paths. |

---

## Startup Contract

1. Spawn child process.
2. Wait for `{"ready": true}` line on stdout before sending any requests.
3. Expose a `ready: Promise<void>` or equivalent to callers.

---

## Shutdown / Signal Rules

All four hooks are **mandatory** in every generated client:

```ts
const kill = () => { if (!proc.killed) proc.kill('SIGTERM'); };

process.on('exit',              kill);
process.on('SIGINT',            () => { kill(); process.exit(0); });
process.on('SIGTERM',           () => { kill(); process.exit(0); });
process.on('uncaughtException', (e) => { kill(); throw e; });
```

- `SIGINT` = user hits **Ctrl+C** — child must die before Node exits.
- Use `SIGTERM` as the kill signal so the child can flush before dying.
- If child doesn't exit within 2 s, escalate to `SIGKILL`.

```ts
proc.kill('SIGTERM');
setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 2000);
```

---

## stdout Framing

- Buffer `data` events; split on `\n`; parse each line as JSON independently.
- Discard empty lines silently.
- On JSON parse failure: `console.warn` the raw line, do not reject any pending promise.

---

## ID Strategy

- Use an incrementing integer counter, cast to string: `"1"`, `"2"`, …
- Store pending calls in `Map<string, {resolve, reject}>`.
- On `error` key in response: reject with `new Error(msg.error.message)` and attach `traceback` as a property.

---

## Cross-Platform Path Helper (mandatory in every client)

```ts
import os from 'os';
import path from 'path';

function resolveChildExecutable(venvRoot: string, execName: string): string {
  return os.platform() === 'win32'
    ? path.join(venvRoot, 'Scripts', `${execName}.exe`)
    : path.join(venvRoot, 'bin', execName);
}
```
