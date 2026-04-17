/**
 * Tests: TypeScript (source) ↔ Ruby (target)
 *
 * Run: npx vitest run languages/typescript/tests/ts-ruby.test.ts
 */

// TODO Phase 2+ — implement after ts→python is green

describe('ts → ruby: basic JSON-RPC', () => {
  test('sends a request and receives a matching response', async () => {
    // Spawn test-child.rb via `ruby` executable
    // Expect {"id":"1","result":{"msg":"hello"}}
    expect.assertions(1);
    // TODO
  });
});

describe('ts → ruby: signal propagation', () => {
  test('Ruby process exits when TS closes stdin', async () => {
    // Close stdin pipe; Ruby watchdog thread should call exit 0 within 1 s
    expect.assertions(1);
    // TODO
  });

  test('Ruby process exits on SIGTERM from TS cleanup hook', async () => {
    expect.assertions(1);
    // TODO
  });
});

describe('ts → ruby: error bubbling', () => {
  test('rejects promise with message and backtrace when Ruby raises', async () => {
    expect.assertions(2);
    // TODO
  });
});
