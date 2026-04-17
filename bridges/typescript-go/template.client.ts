/**
 * Stitch — TypeScript client for a compiled Go sidecar.
 *
 * Spawn path convention:
 *   .stitch/go/<bridgeName>/bridge          (POSIX)
 *   .stitch/go/<bridgeName>/bridge.exe      (Windows)
 *
 * Usage:
 *   const client = new GoBridgeClient("my-bridge");
 *   await client.ready();
 *   const result = await client.call("my_method", { field: "value" });
 *   await client.close();
 */

import { spawn } from "child_process";

import {
  BridgeClientBase,
  RpcRequest,
  killChild,
} from "../../shared/typescript/bridge-client-base";
import { getBinaryPath } from "../../shared/typescript/path-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the platform-aware path to the compiled Go binary.
 *
 * @param bridgeName  The subdirectory name under `.stitch/go/`.
 * @param projectRoot Optional project root; defaults to `process.cwd()`.
 */
export function goBinaryPath(
  bridgeName: string,
  projectRoot: string = process.cwd()
): string {
  return getBinaryPath(
    `${projectRoot}/.stitch/go/${bridgeName}`,
    "",
    "bridge"
  );
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GoBridgeClient extends BridgeClientBase {
  private child: ReturnType<typeof spawn>;

  constructor(
    bridgeName: string,
    options: {
      /** Absolute path to the Go binary. Defaults to the convention path. */
      binaryPath?: string;
      /** Extra environment variables forwarded to the child process. */
      env?: NodeJS.ProcessEnv;
    } = {}
  ) {
    super();
    const binaryPath = options.binaryPath ?? goBinaryPath(bridgeName);

    this.child = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });

    // ---- stderr forwarding ------------------------------------------------
    (this.child.stderr as NodeJS.ReadableStream | null)?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[go-sidecar:${bridgeName}] ${chunk.toString()}`);
    });

    // ---- stdout parser via shared base ------------------------------------
    this.attachStdoutParser(this.child.stdout!);

    // ---- child exit -------------------------------------------------------
    this.child.on("exit", (code, signal) => {
      if (this.dead) return;
      this.dead = true;
      const reason = new Error(
        `Go sidecar exited (code=${code ?? "null"}, signal=${signal ?? "null"})`
      );
      this.rejectReady(reason);
      this._rejectAll(reason);
    });

    // ---- process-level cleanup hooks -------------------------------------
    this.registerCleanupHooks(() => this.destroy());
  }

  // ---- Public API ---------------------------------------------------------

  /** Resolves when the child has emitted `{"ready":true}`. */
  ready(): Promise<void> {
    return this.ready;
  }

  destroy(): void {
    killChild(this.child);
  }

  /** Gracefully close the sidecar by ending stdin (triggers EOF in Go). */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.child.stdin!.end(resolve));
  }

  // ---- Protected write implementation -------------------------------------

  protected _writeRequest(
    request: RpcRequest,
    id: string,
    reject: (err: Error) => void,
  ): void {
    const line = JSON.stringify(request) + "\n";
    this.child.stdin!.write(line, (err) => {
      if (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }
}

export default GoBridgeClient;
