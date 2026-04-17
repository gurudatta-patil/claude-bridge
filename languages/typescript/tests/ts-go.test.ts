/**
 * Tests: TypeScript (source) ↔ Go binary (target)
 *
 * Run: npx vitest run languages/typescript/tests/ts-go.test.ts
 *
 * Pre-requisite: `go build -o test-bridge-go` inside the test fixture dir.
 */

// TODO Phase 3+ — implement after ts→python is green

describe('ts → go: basic JSON-RPC', () => {
  test('sends a request and receives a matching response', async () => {
    expect.assertions(1);
    // TODO
  });
});

describe('ts → go: signal propagation', () => {
  test('Go binary exits when TS closes stdin', async () => {
    expect.assertions(1);
    // TODO
  });

  test('Go binary exits on SIGTERM', async () => {
    expect.assertions(1);
    // TODO
  });
});

describe('ts → go: error bubbling', () => {
  test('rejects promise when Go returns an error object', async () => {
    expect.assertions(2);
    // TODO
  });
});
