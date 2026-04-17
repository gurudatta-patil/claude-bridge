/**
 * ts-rust.test.ts
 *
 * Vitest integration tests for the TypeScript → Rust JSON-RPC bridge.
 *
 * Prerequisites
 * -------------
 *   cargo must be on PATH.
 *   The test-child crate lives at:
 *     bridges/typescript-rust/tests/test-child/
 *
 * Run
 * ---
 *   npx vitest run bridges/typescript-rust/tests/ts-rust.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execSync } from "child_process";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BRIDGE_DIR = path.resolve(__dirname, "test-child");
const BINARY_NAME = os.platform() === "win32" ? "test-child.exe" : "test-child";
const BINARY_PATH = path.join(BRIDGE_DIR, "target", "release", BINARY_NAME);

/** Spawn test-child and return a handle + RPC helper. */
function spawnChild(): {
  proc: ChildProcess;
  call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  waitReady: () => Promise<void>;
  kill: () => void;
} {
  const proc = spawn(BINARY_PATH, [], { stdio: ["pipe", "pipe", "inherit"] });

  let lineBuffer = "";
  const pending = new Map<
    string,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  let readyResolve: (() => void) | null = null;
  let readyDone = false;

  proc.stdout!.on("data", (chunk: Buffer) => {
    lineBuffer += chunk.toString("utf8");
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop()!;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error("[test] unparseable:", line);
        continue;
      }
      if (!readyDone && (msg as { ready?: boolean }).ready === true) {
        readyDone = true;
        readyResolve?.();
        continue;
      }
      const id = msg.id as string;
      const p = pending.get(id);
      if (!p) continue;
      pending.delete(id);
      if ("error" in msg) {
        const e = msg.error as { message: string; traceback: string };
        const err = new Error(e.message);
        (err as Error & { traceback?: string }).traceback = e.traceback;
        p.reject(err);
      } else {
        p.resolve(msg.result as Record<string, unknown>);
      }
    }
  });

  proc.on("exit", () => {
    const err = new Error("child exited unexpectedly");
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  });

  function call(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      const line = JSON.stringify({ id, method, params }) + "\n";
      proc.stdin!.write(line);
    });
  }

  function waitReady(): Promise<void> {
    if (readyDone) return Promise.resolve();
    return new Promise((resolve) => {
      readyResolve = resolve;
    });
  }

  function kill() {
    if (os.platform() === "win32") {
      proc.kill();
    } else {
      proc.kill("SIGTERM");
    }
  }

  return { proc, call, waitReady, kill };
}

// ---------------------------------------------------------------------------
// Build once before all tests
// ---------------------------------------------------------------------------

beforeAll(() => {
  console.log("[ts-rust.test] building test-child (cargo build --release)…");
  execSync("cargo build --release", {
    cwd: BRIDGE_DIR,
    stdio: "inherit",
  });
  console.log("[ts-rust.test] build complete");
}, 120_000 /* allow up to 2 min for first build */);

// ---------------------------------------------------------------------------
// Per-test child lifecycle
// ---------------------------------------------------------------------------

let child: ReturnType<typeof spawnChild> | null = null;

afterEach(async () => {
  child?.kill();
  child = null;
  // Give OS a moment to reap the process.
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(() => {
  child?.kill();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TypeScript → Rust bridge", () => {
  it("sends ready signal on startup", async () => {
    child = spawnChild();
    await child.waitReady();
    // If we reach here without timeout, the ready signal was received.
    expect(true).toBe(true);
  });

  it("echo — round-trip text", async () => {
    child = spawnChild();
    await child.waitReady();
    const result = await child.call("echo", { text: "hello, world" });
    expect(result).toEqual({ text: "hello, world" });
  });

  it("echo — empty string", async () => {
    child = spawnChild();
    await child.waitReady();
    const result = await child.call("echo", { text: "" });
    expect(result).toEqual({ text: "" });
  });

  it("add — integers", async () => {
    child = spawnChild();
    await child.waitReady();
    const result = await child.call("add", { a: 3, b: 4 });
    expect(result).toEqual({ sum: 7 });
  });

  it("add — floats", async () => {
    child = spawnChild();
    await child.waitReady();
    const result = await child.call("add", { a: 1.5, b: 2.25 });
    expect((result as { sum: number }).sum).toBeCloseTo(3.75);
  });

  it("add — missing param returns error", async () => {
    child = spawnChild();
    await child.waitReady();
    await expect(child.call("add", { a: 1 })).rejects.toThrow();
  });

  it("raise_error — error is bubbled to caller", async () => {
    child = spawnChild();
    await child.waitReady();
    await expect(
      child.call("raise_error", { message: "boom from Rust" })
    ).rejects.toThrow("boom from Rust");
  });

  it("raise_error — error object has traceback property", async () => {
    child = spawnChild();
    await child.waitReady();
    try {
      await child.call("raise_error", { message: "trace test" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error & { traceback?: string }).traceback).toBeTruthy();
    }
  });

  it("echo_b64 — base64 encodes text", async () => {
    child = spawnChild();
    await child.waitReady();
    const result = await child.call("echo_b64", { text: "hello" });
    // "hello" in base64 is "aGVsbG8="
    expect(result).toEqual({ encoded: "aGVsbG8=" });
  });

  it("slow — completes after delay", async () => {
    child = spawnChild();
    await child.waitReady();
    const start = Date.now();
    const result = await child.call("slow", { ms: 150 });
    const elapsed = Date.now() - start;
    expect(result).toMatchObject({ done: true, slept_ms: 150 });
    expect(elapsed).toBeGreaterThanOrEqual(130);
  });

  it("unknown method returns error", async () => {
    child = spawnChild();
    await child.waitReady();
    await expect(child.call("no_such_method")).rejects.toThrow(
      "unknown method"
    );
  });

  it("concurrency — 20 simultaneous calls resolved correctly", async () => {
    child = spawnChild();
    await child.waitReady();

    const calls = Array.from({ length: 20 }, (_, i) =>
      child!.call("add", { a: i, b: i })
    );
    const results = await Promise.all(calls);

    results.forEach((r, i) => {
      expect((r as { sum: number }).sum).toBe(i + i);
    });
  });

  it("concurrency — mix of echo and add", async () => {
    child = spawnChild();
    await child.waitReady();

    const echos = Array.from({ length: 10 }, (_, i) =>
      child!.call("echo", { text: `msg-${i}` })
    );
    const adds = Array.from({ length: 10 }, (_, i) =>
      child!.call("add", { a: i, b: 100 })
    );
    const [echoResults, addResults] = await Promise.all([
      Promise.all(echos),
      Promise.all(adds),
    ]);

    echoResults.forEach((r, i) => {
      expect((r as { text: string }).text).toBe(`msg-${i}`);
    });
    addResults.forEach((r, i) => {
      expect((r as { sum: number }).sum).toBe(i + 100);
    });
  });

  it("stdin EOF — child exits when stdin is closed", async () => {
    child = spawnChild();
    await child.waitReady();

    await new Promise<void>((resolve, reject) => {
      child!.proc.on("exit", (code, signal) => {
        // Any exit is acceptable — the key is that it exits.
        resolve();
      });

      // Close stdin to simulate parent dying.
      child!.proc.stdin!.end();

      setTimeout(
        () => reject(new Error("child did not exit after stdin EOF")),
        3_000
      );
    });
  });
});
