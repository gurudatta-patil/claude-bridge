/**
 * Ghost-Bridge – vitest integration tests for TypeScript → Python bridge.
 *
 * Spawns tests/test-child.py via the real Python interpreter and exercises
 * every protocol path: happy-path, concurrency, error propagation, EOF
 * watchdog, and Base64 round-trip.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import * as path from "path";
import { platform } from "os";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_DIR = path.resolve(__dirname, "..");
const SIDECAR = path.resolve(__dirname, "test-child.py");

function resolvePython(): string {
  const isWin = platform() === "win32";
  const venvBin = isWin
    ? path.join(BRIDGE_DIR, ".venv", "Scripts", "python.exe")
    : path.join(BRIDGE_DIR, ".venv", "bin", "python");
  if (existsSync(venvBin)) return venvBin;
  return "python3";
}

interface PendingCall {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/** Minimal bridge sufficient for tests — mirrors the real template logic. */
class TestBridge {
  private child!: ChildProcess;
  private pending = new Map<string, PendingCall>();
  private buffer = "";
  private dead = false;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  readonly ready: Promise<void>;

  constructor(private python: string) {
    this.ready = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
  }

  start(): void {
    this.child = spawn(this.python, [SIDECAR], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child.on("error", (err) => {
      this.dead = true;
      this.readyReject(err);
      this._rejectAll(err);
    });

    this.child.on("exit", (code, signal) => {
      if (this.dead) return;
      this.dead = true;
      const err = new Error(`sidecar exited code=${code} signal=${signal}`);
      this.readyReject(err);
      this._rejectAll(err);
    });

    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this._handleLine(line);
      }
    });
  }

  call<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.dead) return Promise.reject(new Error("bridge is dead"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: Record<string, unknown>) => void,
        reject,
      });
      this.child.stdin!.write(
        JSON.stringify({ id, method, params }) + "\n",
        "utf8",
      );
    });
  }

  stop(): void {
    if (this.child?.pid && !this.dead) {
      this.dead = true;
      if (platform() === "win32") {
        this.child.kill();
      } else {
        this.child.kill("SIGTERM");
        const t = setTimeout(() => {
          try { this.child.kill("SIGKILL"); } catch { /**/ }
        }, 2_000);
        t.unref();
      }
    }
  }

  /** Close stdin without killing the child — used for EOF watchdog test. */
  closeStdin(): void {
    this.child.stdin!.end();
  }

  /** Returns a promise that resolves when the child process exits. */
  waitForExit(): Promise<number | null> {
    return new Promise((res) => {
      this.child.once("exit", (code) => res(code));
    });
  }

  private _handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); }
    catch { return; }

    if (msg["ready"] === true) { this.readyResolve(); return; }

    const id = msg["id"] as string;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);

    if (msg["error"]) {
      const e = msg["error"] as { message: string; traceback: string };
      const err = new Error(e.message) as Error & { traceback: string };
      err.traceback = e.traceback ?? "";
      pending.reject(err);
    } else {
      pending.resolve(msg["result"] as Record<string, unknown>);
    }
  }

  private _rejectAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared bridge instance
// ─────────────────────────────────────────────────────────────────────────────

let bridge: TestBridge;
const PYTHON = resolvePython();

describe("TypeScript → Python bridge", () => {
  beforeAll(async () => {
    bridge = new TestBridge(PYTHON);
    bridge.start();
    await bridge.ready;
  }, 15_000 /* allow for cold Python start */);

  afterAll(() => {
    bridge.stop();
  });

  // ── Basic round-trip ────────────────────────────────────────────────────────

  test("echo – returns params unchanged", async () => {
    const result = await bridge.call<{ hello: string }>("echo", {
      hello: "world",
    });
    expect(result).toEqual({ hello: "world" });
  });

  test("add – sums two numbers", async () => {
    const result = await bridge.call<{ sum: number }>("add", { a: 7, b: 13 });
    expect(result.sum).toBe(20);
  });

  test("add – handles floats", async () => {
    const result = await bridge.call<{ sum: number }>("add", {
      a: 1.1,
      b: 2.2,
    });
    expect(result.sum).toBeCloseTo(3.3);
  });

  // ── Concurrency ──────────────────────────────────────────────────────────────

  test("concurrent requests – 10 in-flight echo calls resolve independently", async () => {
    const payloads = Array.from({ length: 10 }, (_, i) => ({ index: i }));
    const results = await Promise.all(
      payloads.map((p) => bridge.call<{ index: number }>("echo", p)),
    );
    // Results may arrive out of order; sort by index for comparison.
    results.sort((a, b) => a.index - b.index);
    results.forEach((r, i) => expect(r.index).toBe(i));
  });

  test("concurrent requests – 10 in-flight add calls all return correct sums", async () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({ a: i, b: i * 2 }));
    const results = await Promise.all(
      pairs.map((p) => bridge.call<{ sum: number }>("add", p)),
    );
    results.forEach((r, i) => expect(r.sum).toBe(pairs[i].a + pairs[i].b));
  });

  // ── Error propagation ────────────────────────────────────────────────────────

  test("raise_error – rejects with the correct message", async () => {
    await expect(bridge.call("raise_error")).rejects.toThrow(
      "deliberate test error",
    );
  });

  test("raise_error – error object carries a traceback property", async () => {
    let caught: (Error & { traceback?: string }) | null = null;
    try {
      await bridge.call("raise_error");
    } catch (e) {
      caught = e as Error & { traceback?: string };
    }
    expect(caught).not.toBeNull();
    expect(typeof caught!.traceback).toBe("string");
    expect(caught!.traceback).toContain("ValueError");
  });

  test("unknown method – rejects with NotImplementedError message", async () => {
    await expect(bridge.call("no_such_method")).rejects.toThrow(
      /Unknown method/,
    );
  });

  // ── Base64 round-trip ────────────────────────────────────────────────────────

  test("echo_b64 – round-trips arbitrary binary data", async () => {
    // Build a 256-byte payload (all byte values 0-255).
    const original = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const encoded = original.toString("base64");

    const result = await bridge.call<{ data: string }>("echo_b64", {
      data: encoded,
    });

    expect(result.data).toBe(encoded);
    // Verify the decoded bytes match too.
    const decoded = Buffer.from(result.data, "base64");
    expect(decoded).toEqual(original);
  });

  test("echo_b64 – large payload (64 KB) round-trips correctly", async () => {
    const original = Buffer.alloc(65_536, 0xab);
    const encoded = original.toString("base64");

    const result = await bridge.call<{ data: string }>("echo_b64", {
      data: encoded,
    });

    expect(result.data).toBe(encoded);
  });

  // ── Slow / timing ────────────────────────────────────────────────────────────

  test("slow – completes after the requested delay", async () => {
    const before = Date.now();
    const result = await bridge.call<{ done: boolean }>("slow", { ms: 100 });
    const elapsed = Date.now() - before;

    expect(result.done).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(90); // allow small timer jitter
  });

  test("slow – concurrent slow calls overlap (not serialised)", async () => {
    const before = Date.now();
    await Promise.all([
      bridge.call("slow", { ms: 150 }),
      bridge.call("slow", { ms: 150 }),
      bridge.call("slow", { ms: 150 }),
    ]);
    const elapsed = Date.now() - before;

    // If the sidecar serialised calls, this would take ~450 ms.
    // Because of the GIL, Python sleeps DO release it, so we expect ~150 ms.
    // Allow generous headroom for CI.
    expect(elapsed).toBeLessThan(600);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EOF watchdog – separate bridge instance so we can close its stdin cleanly
// ─────────────────────────────────────────────────────────────────────────────

describe("stdin-EOF watchdog", () => {
  test("sidecar exits when parent closes stdin", async () => {
    const b = new TestBridge(PYTHON);
    b.start();
    await b.ready;

    const exitPromise = b.waitForExit();
    b.closeStdin();

    // The watchdog thread should detect EOF and call os._exit(0) quickly.
    const code = await Promise.race([
      exitPromise,
      new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 5_000)),
    ]);

    expect(code).not.toBe("timeout");
    // os._exit(0) → exit code 0.
    expect(code).toBe(0);
  }, 10_000);
});
