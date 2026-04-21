// test-child.js - Stitch Rust→Node.js bridge test sidecar.
//
// Methods exposed:
//   __ping__     {}                    → { pong: true, pid: <number> }
//   echo         { msg: <str> }        → { msg: <str> }
//   add          { a: <num>, b: <num> }→ { sum: <num> }
//   raise_error  {}                    → throws Error("deliberate test error")
//   slow         { ms: <num> }         → { slept_ms: <num> }  (resolves after ms)
'use strict';

const readline = require('readline');

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
const handlers = {
  __ping__: async () => ({ pong: true, pid: process.pid }),

  echo: async ({ msg }) => ({ msg }),

  add: async ({ a, b }) => ({ sum: a + b }),

  raise_error: async () => {
    throw new Error('deliberate test error');
  },

  slow: async ({ ms }) =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ slept_ms: ms }), ms)
    ),
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
async function dispatch(req) {
  const handler = handlers[req.method];
  if (!handler) {
    return {
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    };
  }
  try {
    const result = await handler(req.params || {});
    return { id: req.id, result };
  } catch (err) {
    return {
      id: req.id,
      error: { code: -32000, message: err.message || String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// I/O loop
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin });

// Watchdog: exit if idle for more than 30 s (safety net for the test suite).
let lastActivity = Date.now();
const watchdog = setInterval(() => {
  if (Date.now() - lastActivity > 30_000) {
    process.stderr.write('[test-child] watchdog timeout - exiting\n');
    process.exit(1);
  }
}, 5_000);
watchdog.unref(); // don't keep the event loop alive on its own

// Send ready signal - MUST be the very first line written.
process.stdout.write(JSON.stringify({ ready: true }) + '\n');

rl.on('line', async (line) => {
  lastActivity = Date.now();
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    // Malformed JSON - skip (no id to reply to).
    return;
  }

  const resp = await dispatch(req);
  process.stdout.write(JSON.stringify(resp) + '\n');
});

// stdin EOF - exit cleanly when the parent closes the pipe.
rl.on('close', () => {
  process.stderr.write('[test-child] stdin EOF - exiting\n');
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
