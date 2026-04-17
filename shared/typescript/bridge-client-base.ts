/**
 * Stitch — shared TypeScript client base.
 *
 * Exports the cross-platform kill helper, the pending-call map factory, and
 * the abstract BridgeClientBase class that all TS bridge clients extend.
 */

import { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { platform } from "os";
import { Readable } from "stream";

// ─────────────────────────────────────────────────────────────────────────────
// Internal types (re-exported so bridge implementations can use them)
// ─────────────────────────────────────────────────────────────────────────────

export interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcSuccess {
  id: string;
  result: Record<string, unknown>;
}

export interface RpcError {
  id: string;
  error: { message: string; traceback?: string; backtrace?: string };
}

export type RpcResponse = RpcSuccess | RpcError;

export interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-platform SIGTERM → SIGKILL helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kill a child process cross-platform.
 * On POSIX: sends SIGTERM, escalates to SIGKILL after 2 s with timer.unref().
 * On Windows: calls child.kill() directly (no SIGTERM support).
 */
export function killChild(child: ChildProcess): void {
  if (!child.pid) return;

  if (platform() === "win32") {
    try {
      child.kill();
    } catch {
      /* already dead */
    }
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    return; // already dead
  }

  const escalate = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, 2_000);

  escalate.unref();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending-call map factory
// ─────────────────────────────────────────────────────────────────────────────

export function createPendingMap(): Map<string, PendingCall> {
  return new Map<string, PendingCall>();
}

// ─────────────────────────────────────────────────────────────────────────────
// Abstract base class
// ─────────────────────────────────────────────────────────────────────────────

export abstract class BridgeClientBase {
  protected pending: Map<string, PendingCall> = createPendingMap();
  protected ready: Promise<void>;
  protected resolveReady!: () => void;
  protected rejectReady!: (err: Error) => void;
  protected dead = false;
  private buffer = "";
  private cleanupRegistered = false;

  constructor() {
    this.ready = new Promise<void>((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
  }

  /**
   * Attach a chunked-buffer + newline-split stdout parser to a readable stream.
   * Dispatches each complete line to _handleLine.
   */
  protected attachStdoutParser(stdout: Readable): void {
    stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split("\n");
      // Keep the last (potentially incomplete) fragment in the buffer.
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this._handleLine(trimmed);
      }
    });
  }

  /**
   * Register process-level cleanup hooks (exit, SIGINT, SIGTERM, uncaughtException).
   * Safe to call multiple times — only registers once.
   */
  protected registerCleanupHooks(kill: () => void): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    process.once("exit", kill);
    process.once("SIGINT", () => {
      kill();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      kill();
      process.exit(143);
    });
    process.once("uncaughtException", (err) => {
      console.error("[BridgeClient] uncaughtException:", err);
      kill();
      process.exit(1);
    });
  }

  /**
   * Send a JSON-RPC call to the child and return a Promise for the result.
   * Concrete subclasses must ensure this.child is set and has a writable stdin.
   */
  protected call<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.dead) {
      return Promise.reject(new Error("Bridge is not running"));
    }

    const id = randomUUID();
    const request: RpcRequest = { id, method, params };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: Record<string, unknown>) => void,
        reject,
      });
      this._writeRequest(request, id, reject);
    });
  }

  /** Concrete subclasses implement this to write a serialised request. */
  protected abstract _writeRequest(
    request: RpcRequest,
    id: string,
    reject: (err: Error) => void,
  ): void;

  /** Must be implemented by concrete class to clean up the child process. */
  abstract destroy(): void;

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _handleLine(line: string): void {
    let msg: RpcResponse & { ready?: boolean };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if ((msg as { ready?: boolean }).ready === true) {
      this.resolveReady();
      return;
    }

    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);

    if ("error" in msg && msg.error) {
      const err = new Error(msg.error.message) as Error & {
        traceback?: string;
        backtrace?: string;
      };
      err.traceback = msg.error.traceback ?? "";
      err.backtrace = msg.error.backtrace ?? "";
      pending.reject(err);
    } else if ("result" in msg) {
      pending.resolve((msg as RpcSuccess).result);
    }
  }

  protected _rejectAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
