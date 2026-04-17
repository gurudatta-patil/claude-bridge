/**
 * Stitch – TypeScript client template for a Python sidecar.
 *
 * Slot markers (replaced by the code-generation layer):
 *   [CLAUDE_TYPE_DEFINITIONS_HERE]  – TypeScript interfaces / type aliases
 *   [CLAUDE_PUBLIC_METHODS_HERE]    – public async methods on PythonBridge
 */

import { spawn } from "child_process";
import * as path from "path";

import {
  BridgeClientBase,
  RpcRequest,
  killChild,
} from "../../shared/typescript/bridge-client-base";
import { getVenvPython } from "../../shared/typescript/path-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// [CLAUDE_TYPE_DEFINITIONS_HERE]
//
// Add your request / response interfaces here.  Example:
//
//   export interface AddParams  { a: number; b: number }
//   export interface AddResult  { sum: number }
//
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// PythonBridge
// ─────────────────────────────────────────────────────────────────────────────

export class PythonBridge extends BridgeClientBase {
  private child: ReturnType<typeof spawn> | null = null;

  constructor(
    private readonly scriptPath: string,
    private readonly pythonExe?: string,
  ) {
    super();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const scriptDir = path.dirname(this.scriptPath);
    const python = this.pythonExe ?? getVenvPython(scriptDir);

    this.child = spawn(python, [this.scriptPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child.on("error", (err) => {
      this.dead = true;
      this.rejectReady(err);
      this._rejectAll(err);
    });

    this.child.on("exit", (code, signal) => {
      if (this.dead) return;
      this.dead = true;
      const msg = `Python sidecar exited (code=${code}, signal=${signal})`;
      const err = new Error(msg);
      this.rejectReady(err);
      this._rejectAll(err);
    });

    this.attachStdoutParser(this.child.stdout!);
    this.registerCleanupHooks(() => this.destroy());

    await this.ready;
  }

  async stop(): Promise<void> {
    this.destroy();
  }

  destroy(): void {
    if (this.child) {
      killChild(this.child);
      this.child = null;
    }
  }

  // ── [CLAUDE_PUBLIC_METHODS_HERE] ──────────────────────────────────────────
  //
  // Add your typed public async methods here.  Each method calls this.call()
  // with the appropriate method name and params.  Example:
  //
  //   async add(a: number, b: number): Promise<AddResult> {
  //     return this.call<AddResult>("add", { a, b });
  //   }
  //
  // ─────────────────────────────────────────────────────────────────────────

  // ── Protected write implementation ────────────────────────────────────────

  protected _writeRequest(
    request: RpcRequest,
    id: string,
    reject: (err: Error) => void,
  ): void {
    const line = JSON.stringify(request) + "\n";
    this.child!.stdin!.write(line, "utf8", (err) => {
      if (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }
}
