/**
 * Tests: TypeScript (source) ↔ Python (target)
 *
 * Run: npx vitest run languages/typescript/tests/ts-python.test.ts
 *      (or: npx jest, depending on project setup)
 */

// TODO Phase 1 — implement each test

describe('ts → python: basic JSON-RPC', () => {
  test('sends a request and receives a matching response', async () => {
    // Spawn test-child.py, send {"id":"1","method":"echo","params":{"msg":"hello"}}
    // Expect {"id":"1","result":{"msg":"hello"}}
    expect.assertions(1);
    // TODO
  });

  test('handles 10 concurrent requests with correct id matching', async () => {
    // Send 10 requests without awaiting individually; resolve all via Promise.all
    // Expect all 10 results to match their respective requests
    expect.assertions(10);
    // TODO
  });
});

describe('ts → python: error bubbling', () => {
  test('rejects promise with message and traceback when Python raises', async () => {
    // Call method "raise_error" on test-child.py
    // Expect caught error to have .message and .traceback properties
    expect.assertions(2);
    // TODO
  });
});

describe('ts → python: signal propagation', () => {
  test('Python process exits when TS process sends SIGTERM', async () => {
    // Spawn a long-running Python sidecar
    // Send SIGTERM to the Node process group
    // Poll for Python PID to disappear (timeout 2 s)
    expect.assertions(1);
    // TODO
  });

  test('Python process exits on stdin EOF (simulated parent crash)', async () => {
    // Spawn Python sidecar, then close its stdin pipe
    // Expect Python process to exit within 1 s
    expect.assertions(1);
    // TODO
  });
});

describe('ts → python: binary data (Base64)', () => {
  test('round-trips a small binary payload via Base64', async () => {
    // Send a known byte sequence encoded as Base64
    // Python echoes it back; TS decodes and compares
    expect.assertions(1);
    // TODO
  });
});
