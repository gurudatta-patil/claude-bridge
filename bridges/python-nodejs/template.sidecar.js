// template.sidecar.js - Node.js sidecar template for the Stitch Python→Node.js bridge.
//
// Drop-in template: add your own method handlers inside the `handlers` object,
// then point the Python NodeBridge at this file with:
//
//   NodeBridge(["node", "sidecar.js"])
//
// This file uses CommonJS (require) and works with Node 14+.

// ── tsx / TypeScript usage ──────────────────────────────────────────────────
// To run this sidecar as TypeScript (no compilation step required):
//   1. Rename this file to sidecar.ts and add TypeScript types as needed.
//   2. Change the spawn command in your client from:
//        ["node", "sidecar.js"]
//      to:
//        ["npx", "tsx", "sidecar.ts"]
//      or (if tsx is globally installed):
//        ["tsx", "sidecar.ts"]
// ────────────────────────────────────────────────────────────────────────────
'use strict';

const readline = require('readline');

// ---------------------------------------------------------------------------
// Handler registry – add your own async methods here.
//
// Each handler receives the `params` object from the JSON-RPC request and
// must return a JSON-serialisable value (or throw an Error).
// ---------------------------------------------------------------------------
const handlers = {
  // Built-in ping – useful for health checks and latency measurement.
  __ping__: async () => ({ pong: true, pid: process.pid }),

  // Example: echo the params back as the result.
  // echo: async ({ msg }) => ({ msg }),

  // Example: add two numbers.
  // add: async ({ a, b }) => ({ sum: a + b }),

  // [CLAUDE_HANDLER_FUNCTIONS_HERE]
  // Add your own handlers above this line.
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
    // If the handler returns an async generator (or any async iterable),
    // send chunk frames and terminate with an empty result.
    // traceparent from req is passed through in debug logs automatically.
    if (result && typeof result[Symbol.asyncIterator] === 'function') {
      for await (const chunk of result) {
        process.stdout.write(JSON.stringify({ id: req.id, chunk }) + '\n');
      }
      return { id: req.id, result: {} };
    }
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

// Send ready signal – MUST be the very first line written to stdout.
process.stdout.write(JSON.stringify({ ready: true }) + '\n');

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    // Malformed JSON – nothing to reply to without an id.
    return;
  }

  const resp = await dispatch(req);
  process.stdout.write(JSON.stringify(resp) + '\n');
});

// stdin EOF watchdog – exit cleanly when the parent closes the pipe.
rl.on('close', () => process.exit(0));

// Signal traps.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
