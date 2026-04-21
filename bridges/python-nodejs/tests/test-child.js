// tests/test-child.js - Node.js test sidecar for the Stitch Python→Node.js bridge.
//
// Spawned by tests/test-client.py and tests/python-nodejs_test.py.
//
// Methods
// -------
//   __ping__()            → { pong: true, pid }
//   echo({ msg })         → { msg }
//   add({ a, b })         → { sum: a + b }
//   raise_error({})       → throws Error("deliberate test error")
//   slow({ ms })          → sleeps ms milliseconds, then returns { done: true }
'use strict';

const readline = require('readline');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a Promise that resolves after `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------
const handlers = {
  __ping__: async () => ({ pong: true, pid: process.pid }),

  echo: async ({ msg }) => {
    if (msg === undefined) throw new Error("missing param: msg");
    return { msg };
  },

  add: async ({ a, b }) => {
    if (a === undefined) throw new Error("missing param: a");
    if (b === undefined) throw new Error("missing param: b");
    return { sum: a + b };
  },

  raise_error: async () => {
    throw new Error("deliberate test error");
  },

  slow: async ({ ms = 100 }) => {
    await sleep(Number(ms));
    return { done: true };
  },
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

// Ready signal – must be the very first line written.
process.stdout.write(JSON.stringify({ ready: true }) + '\n');

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return; // malformed JSON – no id to reply to
  }

  const resp = await dispatch(req);
  process.stdout.write(JSON.stringify(resp) + '\n');
});

// EOF watchdog – exit cleanly when the parent closes the pipe.
rl.on('close', () => process.exit(0));

// Signal traps.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
