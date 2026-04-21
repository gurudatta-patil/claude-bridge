/**
 * Stitch TypeScript client template - Ruby sidecar edition.
 * Generated for bridge: [CLAUDE_BRIDGE_NAME]
 * Do NOT edit - regenerate via Stitch CLI
 */

import { spawn } from 'child_process';
import * as path from 'path';

import {
  BridgeClientBase,
  RpcRequest,
  killChild,
} from '../../shared/typescript/bridge-client-base';

// ── [CLAUDE_BRIDGE_NAME] client ──────────────────────────────────────────────

export class [CLAUDE_CLIENT_CLASS_NAME] extends BridgeClientBase {
  /** Path to the Ruby sidecar script - override via constructor option. */
  private readonly scriptPath: string;
  private child: ReturnType<typeof spawn> | null = null;

  /** Ruby runtime executable – 'ruby' (default) or 'jruby'. */
  private readonly runtime: string;

  constructor(options?: { scriptPath?: string; runtime?: 'ruby' | 'jruby' }) {
    super();
    this.scriptPath =
      options?.scriptPath ??
      path.join(__dirname, '[CLAUDE_DEFAULT_SCRIPT_NAME].rb');
    this.runtime = options?.runtime ?? 'ruby';
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.child) return; // already running

    this.child = spawn(this.runtime, [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.child.on('error', (err) => {
      this.dead = true;
      this.rejectReady(err);
      this._rejectAll(err);
    });

    this.child.on('exit', (code, signal) => {
      if (this.dead) return;
      this.dead = true;
      const msg = `Ruby sidecar exited (code=${code}, signal=${signal})`;
      const err = new Error(msg);
      this.rejectReady(err);
      this._rejectAll(err);
      this.child = null;
    });

    this.attachStdoutParser(this.child.stdout!);
    this.registerCleanupHooks(() => this.destroy());

    await this.ready;
  }

  async stop(): Promise<void> {
    this.destroy();
  }

  destroy(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    killChild(child);
  }

  // ── Protected write implementation ────────────────────────────────────────

  protected _writeRequest(
    request: RpcRequest,
    id: string,
    reject: (err: Error) => void,
  ): void {
    const line = JSON.stringify(request) + '\n';
    this.child!.stdin!.write(line, 'utf8');
  }
}
