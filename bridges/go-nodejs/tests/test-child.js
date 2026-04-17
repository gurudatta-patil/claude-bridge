// test-child.js — real Node.js sidecar used by the Go test suite.
//
// Methods:
//   echo        — returns params unchanged
//   add         — {a, b} → {sum}
//   raise_error — always returns a JSON-RPC error
//   echo_b64    — decodes a base-64 string and re-encodes it (Buffer round-trip)
//   slow        — waits `ms` milliseconds then returns {tag, ms}
'use strict';

const readline = require('readline');

const handlers = {
  echo: async (params) => params,

  add: async ({ a, b }) => ({ sum: a + b }),

  raise_error: async ({ msg }) => {
    throw new Error(msg || 'intentional error');
  },

  echo_b64: async ({ data }) => {
    // Decode base-64 → Buffer → re-encode as base-64.
    const buf = Buffer.from(data, 'base64');
    return { decoded: buf.toString('utf8'), reencoded: buf.toString('base64') };
  },

  slow: async ({ ms = 100, tag = 0 }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { tag, ms };
  },
};

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

const rl = readline.createInterface({ input: process.stdin });

process.stdout.write(JSON.stringify({ ready: true }) + '\n');

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  const resp = await dispatch(req);
  process.stdout.write(JSON.stringify(resp) + '\n');
});

rl.on('close', () => process.exit(0));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
