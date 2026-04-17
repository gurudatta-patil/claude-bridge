/**
 * Tests: TypeScript (source) ↔ Rust binary (target)
 *
 * Run: npx vitest run languages/typescript/tests/ts-rust.test.ts
 *
 * Pre-requisite: `cargo build --release` inside the test fixture bridge dir.
 */

// TODO Phase 3+ — implement after ts→python and ts→ruby are green

describe('ts → rust: basic JSON-RPC', () => {
  test('sends a request and receives a matching response', async () => {
    expect.assertions(1);
    // TODO
  });
});

describe('ts → rust: signal propagation', () => {
  test('Rust binary exits when TS closes stdin', async () => {
    // Rust loop breaks on stdin EOF
    expect.assertions(1);
    // TODO
  });

  test('Rust binary exits on SIGTERM', async () => {
    // ctrlc handler calls process::exit(0)
    expect.assertions(1);
    // TODO
  });
});

describe('ts → rust: error bubbling', () => {
  test('rejects promise when Rust returns an error object', async () => {
    expect.assertions(2);
    // TODO
  });
});
