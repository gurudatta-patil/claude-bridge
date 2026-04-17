/**
 * Stitch — TypeScript → Go integration tests
 *
 * Before running: ensure `go` is on PATH.
 * The suite compiles the test-child sidecar automatically via execSync.
 *
 * Run:
 *   npx vitest run bridges/typescript-go/tests/ts-go.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { GoBridgeClient } from "../template.client";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const TEST_CHILD_DIR = path.join(__dirname, "test-child");
const BINARY_NAME = process.platform === "win32" ? "test-bridge-go.exe" : "test-bridge-go";
const BINARY_PATH = path.join(TEST_CHILD_DIR, BINARY_NAME);

// ---------------------------------------------------------------------------
// Build step
// ---------------------------------------------------------------------------

beforeAll(() => {
  console.log("[setup] Compiling Go test sidecar…");
  execSync(`go build -o ${BINARY_NAME} .`, {
    cwd: TEST_CHILD_DIR,
    stdio: "inherit",
    timeout: 60_000,
  });
  console.log(`[setup] Binary ready at ${BINARY_PATH}`);
}, 60_000);

// ---------------------------------------------------------------------------
// Shared client
// ---------------------------------------------------------------------------

let client: GoBridgeClient;

beforeAll(async () => {
  client = new GoBridgeClient("test", { binaryPath: BINARY_PATH });
  await client.ready();
}, 15_000);

afterAll(async () => {
  await client.close();
  // Clean up compiled binary so the repo stays clean.
  try {
    fs.unlinkSync(BINARY_PATH);
  } catch {
    // ignore if already gone
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TypeScript → Go bridge", () => {
  // ---- Round-trip ----------------------------------------------------------

  it("echo: round-trips a plain string", async () => {
    const result = (await client.call("echo", { message: "hello go" })) as {
      message: string;
    };
    expect(result.message).toBe("hello go");
  });

  it("echo: round-trips an empty string", async () => {
    const result = (await client.call("echo", { message: "" })) as {
      message: string;
    };
    expect(result.message).toBe("");
  });

  it("add: sums two integers", async () => {
    const result = (await client.call("add", { a: 7, b: 3 })) as {
      sum: number;
    };
    expect(result.sum).toBe(10);
  });

  it("add: sums two floats", async () => {
    const result = (await client.call("add", { a: 1.5, b: 2.5 })) as {
      sum: number;
    };
    expect(result.sum).toBeCloseTo(4.0);
  });

  it("echo_b64: encodes to base64", async () => {
    const result = (await client.call("echo_b64", { data: "stitch" })) as {
      encoded: string;
    };
    expect(result.encoded).toBe(Buffer.from("stitch").toString("base64"));
  });

  it("echo_b64: handles unicode payload", async () => {
    const input = "こんにちは世界";
    const result = (await client.call("echo_b64", { data: input })) as {
      encoded: string;
    };
    const decoded = Buffer.from(result.encoded, "base64").toString("utf8");
    expect(decoded).toBe(input);
  });

  // ---- Error bubbling ------------------------------------------------------

  it("raise_error: rejects with the sidecar error message", async () => {
    await expect(
      client.call("raise_error", { message: "boom from Go" })
    ).rejects.toThrow("boom from Go");
  });

  it("raise_error: rejected Error carries a traceback property", async () => {
    let caught: (Error & { traceback?: string }) | undefined;
    try {
      await client.call("raise_error", { message: "traceback test" });
    } catch (e) {
      caught = e as Error & { traceback?: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.traceback).toBeTruthy();
  });

  it("unknown method: returns an error response", async () => {
    await expect(
      client.call("does_not_exist", {})
    ).rejects.toThrow("unknown method: does_not_exist");
  });

  // ---- Slow / timing -------------------------------------------------------

  it("slow: completes after the requested delay", async () => {
    const before = Date.now();
    const result = (await client.call("slow", {
      ms: 100,
      message: "delayed",
    })) as { slept_ms: number; message: string };
    const elapsed = Date.now() - before;
    expect(result.slept_ms).toBe(100);
    expect(result.message).toBe("delayed");
    expect(elapsed).toBeGreaterThanOrEqual(90); // allow ±10 ms jitter
  });

  // ---- Concurrency ---------------------------------------------------------

  it("concurrency: resolves 20 parallel calls without mixing up IDs", async () => {
    const calls = Array.from({ length: 20 }, (_, i) =>
      client.call("echo", { message: `msg-${i}` })
    );
    const results = (await Promise.all(calls)) as { message: string }[];
    for (let i = 0; i < 20; i++) {
      expect(results[i].message).toBe(`msg-${i}`);
    }
  });

  it("concurrency: mixes echo and add calls correctly", async () => {
    const [echoResult, addResult] = await Promise.all([
      client.call("echo", { message: "parallel-echo" }),
      client.call("add", { a: 100, b: 200 }),
    ]);
    expect((echoResult as { message: string }).message).toBe("parallel-echo");
    expect((addResult as { sum: number }).sum).toBe(300);
  });

  it("concurrency: 5 slow calls complete independently", async () => {
    const before = Date.now();
    const calls = Array.from({ length: 5 }, (_, i) =>
      client.call("slow", { ms: 50, message: `slow-${i}` })
    );
    const results = (await Promise.all(calls)) as {
      slept_ms: number;
      message: string;
    }[];
    const elapsed = Date.now() - before;
    // All 5 calls run in parallel from the TS side; Go handles them
    // sequentially per the single-threaded scanner loop, so total time
    // will be ~250 ms. We just verify correctness here.
    for (let i = 0; i < 5; i++) {
      expect(results[i].slept_ms).toBe(50);
    }
    // Should NOT take more than 5 × 50 + 500 ms of headroom.
    expect(elapsed).toBeLessThan(5 * 50 + 500);
  });

  // ---- stdin EOF defence ---------------------------------------------------

  it("stdin-EOF: close() resolves and subsequent calls reject cleanly", async () => {
    // Spin up a second client so we can close it without breaking the suite.
    const tempClient = new GoBridgeClient("test", { binaryPath: BINARY_PATH });
    await tempClient.ready();

    // Verify it is working.
    const r = (await tempClient.call("echo", { message: "before-close" })) as {
      message: string;
    };
    expect(r.message).toBe("before-close");

    // Close it (sends EOF to stdin).
    await tempClient.close();

    // Any call after close should reject (child has exited).
    await expect(
      tempClient.call("echo", { message: "after-close" })
    ).rejects.toThrow();
  });

  // ---- Large payload -------------------------------------------------------

  it("echo_b64: handles a 500 KB payload without truncation", async () => {
    const large = "x".repeat(500 * 1024);
    const result = (await client.call("echo_b64", { data: large })) as {
      encoded: string;
    };
    const decoded = Buffer.from(result.encoded, "base64").toString("utf8");
    expect(decoded).toBe(large);
  });
});
