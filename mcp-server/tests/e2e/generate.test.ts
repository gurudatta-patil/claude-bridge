/**
 * E2e test: real `claude --print` → write files → spawn sidecar → verify → clean up.
 *
 * Gated behind: GHOST_BRIDGE_E2E=1
 * Run with:  GHOST_BRIDGE_E2E=1 npx vitest run tests/e2e
 *
 * What this test does:
 *   1. Calls generateBridge() (verbose=true) which spawns `claude --print <prompt>`
 *   2. Prints Claude's full raw response to stderr so you can see it
 *   3. Writes the generated Python to a temp dir
 *   4. Spawns the Python sidecar directly (no venv needed for a no-dep bridge)
 *   5. Calls echo and add via the JSON-RPC protocol
 *   6. Verifies responses are correct
 *   7. Closes stdin (EOF watchdog test) and waits for clean exit
 *   8. Deletes the temp dir
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess, spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { generateBridge } from "../../src/generator.js";

const E2E = process.env["GHOST_BRIDGE_E2E"] === "1";
const describeIf = E2E ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SHARED_PYTHON = path.join(REPO_ROOT, "shared", "python_sidecar");

// ─────────────────────────────────────────────────────────────────────────────
// Minimal bridge client for e2e
// ─────────────────────────────────────────────────────────────────────────────

interface PendingCall {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

class E2EBridge {
  private child!: ChildProcess;
  private pending = new Map<string, PendingCall>();
  private buffer = "";
  private stderrLines: string[] = [];
  private dead = false;
  private _readyResolve!: () => void;
  private _readyReject!: (e: Error) => void;
  readonly ready: Promise<void>;

  constructor(
    private scriptPath: string,
    private env: NodeJS.ProcessEnv,
  ) {
    this.ready = new Promise<void>((res, rej) => {
      this._readyResolve = res;
      this._readyReject = rej;
    });
  }

  start(): void {
    this.child = spawn("python3", [this.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
    });

    // Capture stderr — shows import errors, tracebacks, etc.
    this.child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrLines.push(text);
      process.stderr.write("[sidecar stderr] " + text);
    });

    this.child.on("error", (err) => {
      this.dead = true;
      this._readyReject(err);
      this._rejectAll(err);
    });

    this.child.on("exit", (code, signal) => {
      if (this.dead) return;
      this.dead = true;
      const stderr = this.stderrLines.join("").slice(-500);
      const err = new Error(
        `sidecar exited code=${code} signal=${signal}\nstderr:\n${stderr}`,
      );
      this._readyReject(err);
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

  closeStdin(): void {
    this.child.stdin!.end();
  }

  waitForExit(): Promise<number | null> {
    return new Promise((res) => this.child.once("exit", (code) => res(code)));
  }

  stop(): void {
    if (!this.dead) {
      this.dead = true;
      try { this.child.kill("SIGTERM"); } catch { /**/ }
    }
  }

  getStderr(): string {
    return this.stderrLines.join("");
  }

  private _handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg["ready"] === true) { this._readyResolve(); return; }

    const id = msg["id"] as string;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);

    if (msg["error"]) {
      const e = msg["error"] as { message: string };
      pending.reject(new Error(e.message));
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
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describeIf("E2e: claude generates bridge → runs → cleans up", () => {
  let tempDir: string;
  let pyPath: string;
  let generatedPython: string;
  let bridge: E2EBridge;

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `ghost-bridge-e2e-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });

    process.stderr.write(`\n[e2e] temp dir: ${tempDir}\n`);
    process.stderr.write(`[e2e] calling claude --print ...\n`);

    // Generate a simple echo+add bridge with no extra dependencies.
    const result = await generateBridge({
      bridgeName: "e2e_test",
      targetCapability:
        "Expose two methods: " +
        "(1) echo — returns the params dict unchanged; " +
        "(2) add — takes {a: number, b: number} and returns {sum: number}. " +
        "No extra imports needed beyond stdlib.",
      dependencies: [],
      repoRoot: REPO_ROOT,
      verbose: true, // prints Claude's response to stderr
    });

    generatedPython = result.python;

    process.stderr.write(
      `\n[e2e] Generated Python (${generatedPython.split("\n").length} lines):\n` +
      "─".repeat(60) + "\n" +
      generatedPython + "\n" +
      "─".repeat(60) + "\n",
    );

    pyPath = path.join(tempDir, "e2e_test.py");
    writeFileSync(pyPath, generatedPython + "\n", "utf8");
    expect(existsSync(pyPath)).toBe(true);

    // PYTHONPATH → shared/python_sidecar so the relative import works
    // even though __file__ is in a temp dir.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONPATH: `${SHARED_PYTHON}${path.delimiter}${process.env["PYTHONPATH"] ?? ""}`,
    };

    bridge = new E2EBridge(pyPath, env);
    bridge.start();
    await bridge.ready;

    process.stderr.write("[e2e] sidecar ready\n");
  }, 120_000);

  afterAll(() => {
    bridge?.stop();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    process.stderr.write("[e2e] cleaned up temp dir\n");
  });

  test("echo – returns params unchanged", async () => {
    const result = await bridge.call<{ hello: string }>("echo", {
      hello: "world",
    });
    expect(result).toMatchObject({ hello: "world" });
  }, 30_000);

  test("add – sums two integers", async () => {
    const result = await bridge.call<{ sum: number }>("add", { a: 4, b: 6 });
    expect(result.sum).toBe(10);
  }, 30_000);

  test("concurrent echo calls resolve independently", async () => {
    const payloads = Array.from({ length: 5 }, (_, i) => ({ index: i }));
    const results = await Promise.all(
      payloads.map((p) => bridge.call<{ index: number }>("echo", p)),
    );
    results.sort((a, b) => a.index - b.index);
    results.forEach((r, i) => expect(r.index).toBe(i));
  }, 30_000);

  test("generated Python passes validation rules", () => {
    expect(generatedPython).toContain("_rpc_out = _sys.stdout");
    expect(generatedPython).toContain("_sys.stdout = _sys.stderr");
    expect(generatedPython).toContain("run_sidecar(HANDLERS)");
    expect(generatedPython).not.toMatch(/(?<![_\w])print\s*\(/);
  });

  test("EOF watchdog – sidecar exits cleanly when stdin is closed", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONPATH: `${SHARED_PYTHON}${path.delimiter}${process.env["PYTHONPATH"] ?? ""}`,
    };
    const b = new E2EBridge(pyPath, env);
    b.start();
    await b.ready;

    const exitP = b.waitForExit();
    b.closeStdin();

    const code = await Promise.race([
      exitP,
      new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 5_000)),
    ]);

    expect(code).not.toBe("timeout");
    expect(code).toBe(0);
  }, 15_000);
});
