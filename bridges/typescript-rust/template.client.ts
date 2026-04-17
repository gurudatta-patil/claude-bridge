/**
 * template.client.ts
 *
 * TypeScript client that spawns a compiled Rust sidecar binary and
 * communicates with it over newline-delimited JSON-RPC on stdin/stdout.
 *
 * Usage
 * -----
 *   import { RustBridgeClient } from "./template.client";
 *
 *   const client = new RustBridgeClient("my_bridge");
 *   await client.start();
 *   const result = await client.call("echo", { text: "hello" });
 *   await client.stop();
 */

import { spawn } from "child_process";

import {
  BridgeClientBase,
  RpcRequest,
  killChild,
} from "../../shared/typescript/bridge-client-base";
import { getBinaryPath } from "../../shared/typescript/path-helpers";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the compiled Rust binary for the given bridge.
 *
 * Convention:
 *   <repo-root>/.ghost-bridge/rust/<bridgeName>/target/release/<bridgeName>[.exe]
 */
export function resolveBinaryPath(
  bridgeName: string,
  repoRoot: string = process.cwd()
): string {
  return getBinaryPath(
    `${repoRoot}/.ghost-bridge/rust/${bridgeName}`,
    "target/release",
    bridgeName
  );
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class RustBridgeClient extends BridgeClientBase {
  private bridgeName: string;
  private binaryPath: string;
  private child: ReturnType<typeof spawn> | null = null;

  /**
   * @param bridgeName  Name of the Rust crate / binary (no extension).
   * @param repoRoot    Absolute path to the repository root.
   *                    Defaults to `process.cwd()`.
   */
  constructor(bridgeName: string, repoRoot?: string) {
    super();
    this.bridgeName = bridgeName;
    this.binaryPath = resolveBinaryPath(bridgeName, repoRoot);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Spawn the sidecar and wait for the `{"ready":true}` handshake. */
  async start(): Promise<void> {
    if (this.child) {
      throw new Error("RustBridgeClient: already started");
    }

    this.child = spawn(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child.on("error", (err) => {
      this.dead = true;
      this.rejectReady(
        new Error(`[RustBridgeClient:${this.bridgeName}] spawn error: ${err.message}`)
      );
      this._rejectAll(err);
    });

    this.child.on("exit", (code, signal) => {
      if (this.dead) return;
      this.dead = true;
      const reason = new Error(
        `[RustBridgeClient:${this.bridgeName}] child exited (code=${code}, signal=${signal})`
      );
      this.rejectReady(reason);
      this._rejectAll(reason);
      this.child = null;
    });

    this.attachStdoutParser(this.child.stdout!);
    this.registerCleanupHooks(() => this.destroy());

    await this.ready;
  }

  /** Send SIGTERM to the child (SIGKILL after 2 s if still alive). */
  async stop(): Promise<void> {
    if (!this.child) return;
    this.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  destroy(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    killChild(child);
  }

  // -------------------------------------------------------------------------
  // Protected write implementation
  // -------------------------------------------------------------------------

  protected _writeRequest(
    request: RpcRequest,
    id: string,
    reject: (err: Error) => void,
  ): void {
    const line = JSON.stringify(request) + "\n";
    this.child!.stdin!.write(line, "utf8", (err) => {
      if (err) {
        this.pending.delete(id);
        reject(
          new Error(
            `[RustBridgeClient:${this.bridgeName}] stdin write error: ${err.message}`
          )
        );
      }
    });
  }
}
