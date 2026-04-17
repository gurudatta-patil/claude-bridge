// template.sidecar.js — Node.js sidecar template for the Stitch Go→Node.js bridge.
//
// Drop-in template: add your own method handlers inside the `handlers` object.
// This file uses CommonJS (require) and works with Node 14+.
'use strict';

const readline = require('readline');

// ---------------------------------------------------------------------------
// Handler registry — add your own methods here.
// ---------------------------------------------------------------------------
const handlers = {
  // Example: echo the params back as the result.
  echo: async (params) => params,

  // Example: add two numbers.
  add: async ({ a, b }) => ({ sum: a + b }),
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

// Send ready signal — MUST be the very first line written.
process.stdout.write(JSON.stringify({ ready: true }) + '\n');

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    // Malformed JSON — nothing to reply to without an id.
    return;
  }

  const resp = await dispatch(req);
  process.stdout.write(JSON.stringify(resp) + '\n');
});

// stdin EOF watchdog — exit cleanly when the parent closes the pipe.
rl.on('close', () => process.exit(0));

// Signal traps.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
