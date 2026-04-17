import { spawn } from "child_process";
import * as path from "path";
import { randomUUID } from "crypto";

export interface EchoParams { message: string }
export interface EchoResult { message: string }
export interface AddParams { a: number; b: number }
export interface AddResult { sum: number }

export class Stitch {
  private child: ReturnType<typeof spawn> | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private dead = false;
  private _readyResolve!: () => void;
  private _readyReject!: (e: Error) => void;
  readonly ready: Promise<void>;

  constructor(private scriptPath: string) {
    this.ready = new Promise<void>((res, rej) => {
      this._readyResolve = res;
      this._readyReject = rej;
    });
  }

  async start(): Promise<void> {
    this.child = spawn("python3", [this.scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this._handleLine(line);
      }
    });
    await this.ready;
  }

  private _handleLine(line: string): void {
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (msg["ready"]) { this._readyResolve(); return; }
    const id = msg["id"] as string;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (msg["error"]) {
      p.reject(new Error((msg["error"] as { message: string }).message));
    } else {
      p.resolve(msg["result"]);
    }
  }

  async echo(params: EchoParams): Promise<EchoResult> {
    return this.call<EchoResult>("echo", params);
  }

  async add(params: AddParams): Promise<AddResult> {
    return this.call<AddResult>("add", params);
  }

  private call<T>(method: string, params: unknown = {}): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child!.stdin!.write(JSON.stringify({ id, method, params }) + "\n", "utf8");
    });
  }

  killChild(): void {
    if (this.child && !this.dead) {
      this.dead = true;
      this.child.kill("SIGTERM");
      const t = setTimeout(() => { try { this.child!.kill("SIGKILL"); } catch { /**/ } }, 2000);
      t.unref();
    }
  }

  async stop(): Promise<void> {
    this.killChild();
    this.child = null;
  }
}
