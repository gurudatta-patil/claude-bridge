/**
 * E2e test: scaffold → venv → spawn sidecar → verify → clean up.
 *
 * Gated behind: STITCH_E2E=1
 * Run with:  STITCH_E2E=1 npx vitest run tests/e2e
 *
 * What this test does:
 *   1. Calls handleGetTemplates to get the real typescript-python templates.
 *   2. Uses a pre-written Python sidecar (no Claude call needed — the MCP no
 *      longer does code generation internally).
 *   3. Calls handleSetupStitch to scaffold: writes files, copies shared
 *      helpers, creates a real venv, installs no deps.
 *   4. Spawns the Python sidecar using the venv created by scaffolding.
 *   5. Calls echo and add via JSON-RPC, asserts correct results.
 *   6. Closes stdin and verifies the sidecar exits cleanly (EOF handling).
 *   7. Deletes the temp dir.
 *
 * NOTE: if you also want to test that Claude Code fills in templates correctly,
 * set STITCH_CLAUDE_E2E=1 in addition — that sub-test calls claude --print.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess, spawn, execFile as _execFile } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { handleGetTemplates, handleSetupStitch } from "../../src/tool.js";

const execFile = promisify(_execFile);

const E2E = process.env["STITCH_E2E"] === "1";
const describeIf = E2E ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

// ─────────────────────────────────────────────────────────────────────────────
// A known-good Python sidecar with echo + add methods.
// Claude fills in exactly this kind of code when using the typescript-python
// templates. Using it here means the e2e test doesn't require a Claude call.
// ─────────────────────────────────────────────────────────────────────────────

const E2E_PYTHON_SIDECAR = `
import sys as _sys

_rpc_out = _sys.stdout
_sys.stdout = _sys.stderr

# [CLAUDE_IMPORTS_HERE] — stdlib only

def handle_echo(params: dict) -> dict:
    return params

def handle_add(params: dict) -> dict:
    return {"sum": params["a"] + params["b"]}

HANDLERS = {
    "echo": handle_echo,
    "add":  handle_add,
}

import sys as _sys2
import os as _os
_sys2.path.insert(0, _os.path.join(_os.path.dirname(__file__), '..', 'shared'))
from sidecar_base import run_sidecar, set_rpc_out  # noqa: E402

set_rpc_out(_rpc_out)

if __name__ == "__main__":
    run_sidecar(HANDLERS)
`.trim();

// Minimal TypeScript client fixture (content doesn't matter for runtime test).
const E2E_TS_CLIENT = readFileSync(
  path.resolve(__dirname, "../fixtures/valid-typescript.ts"),
  "utf8",
);

// ─────────────────────────────────────────────────────────────────────────────
// Minimal bridge client for e2e (same as before)
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

  constructor(private pythonExe: string, private scriptPath: string) {
    this.ready = new Promise<void>((res, rej) => {
      this._readyResolve = res;
      this._readyReject = rej;
    });
  }

  start(): void {
    this.child = spawn(this.pythonExe, [this.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrLines.push(text);
      process.stderr.write("[sidecar] " + text);
    });

    this.child.on("error", (err) => {
      this.dead = true;
      this._readyReject(err);
      this._rejectAll(err);
    });

    this.child.on("exit", (code, signal) => {
      if (this.dead) return;
      this.dead = true;
      const err = new Error(
        `sidecar exited code=${code} signal=${signal}\n` +
          this.stderrLines.join("").slice(-500),
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
      this.pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
      this.child.stdin!.write(JSON.stringify({ id, method, params }) + "\n", "utf8");
    });
  }

  closeStdin(): void { this.child.stdin!.end(); }
  waitForExit(): Promise<number | null> {
    return new Promise((res) => this.child.once("exit", (code) => res(code)));
  }
  stop(): void {
    if (!this.dead) { this.dead = true; try { this.child.kill("SIGTERM"); } catch { /**/ } }
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
      pending.reject(new Error((msg["error"] as { message: string }).message));
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

describeIf("E2e: scaffold → real venv → spawn sidecar → verify", () => {
  let tempDir: string;
  let pyPath: string;
  let pythonExe: string;
  let bridge: E2EBridge;

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `stitch-e2e-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    process.stderr.write(`\n[e2e] temp dir: ${tempDir}\n`);

    // 1. Scaffold using real file writes + real venv creation.
    const result = await handleSetupStitch({
      bridge_name: "e2e_test",
      language_pair: "typescript-python",
      client_code: E2E_TS_CLIENT,
      sidecar_code: E2E_PYTHON_SIDECAR,
      dependencies: [],
      project_root: tempDir,
    });

    pyPath = result.sidecar_path;
    process.stderr.write(`[e2e] sidecar path: ${pyPath}\n`);
    expect(existsSync(pyPath)).toBe(true);

    // Use the venv Python created by scaffolding.
    const venvPy = path.join(tempDir, ".stitch", "bridges", ".venv", "bin", "python");
    pythonExe = existsSync(venvPy) ? venvPy : "python3";
    process.stderr.write(`[e2e] python: ${pythonExe}\n`);

    bridge = new E2EBridge(pythonExe, pyPath);
    bridge.start();
    await bridge.ready;
    process.stderr.write("[e2e] sidecar ready ✓\n");
  }, 120_000);

  afterAll(() => {
    bridge?.stop();
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    process.stderr.write("[e2e] cleaned up\n");
  });

  test("get_stitch_templates returns real typescript-python templates", async () => {
    const t = await handleGetTemplates({ language_pair: "typescript-python" });
    expect(t.clientTemplate).toContain("[CLAUDE_TYPE_DEFINITIONS_HERE]");
    expect(t.sidecarTemplate).toContain("[CLAUDE_IMPORTS_HERE]");
    expect(t.clientFenceTag).toBe("typescript");
    expect(t.sidecarFenceTag).toBe("python");
  });

  test("echo – returns params unchanged", async () => {
    const result = await bridge.call<{ hello: string }>("echo", { hello: "world" });
    expect(result).toMatchObject({ hello: "world" });
  }, 30_000);

  test("add – sums two integers", async () => {
    const result = await bridge.call<{ sum: number }>("add", { a: 4, b: 6 });
    expect(result.sum).toBe(10);
  }, 30_000);

  test("concurrent echo calls resolve independently", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        bridge.call<{ index: number }>("echo", { index: i }),
      ),
    );
    results.sort((a, b) => a.index - b.index);
    results.forEach((r, i) => expect(r.index).toBe(i));
  }, 30_000);

  test("EOF – sidecar exits cleanly when stdin is closed", async () => {
    const b = new E2EBridge(pythonExe, pyPath);
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
