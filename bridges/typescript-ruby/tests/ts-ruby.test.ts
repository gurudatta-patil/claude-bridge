/**
 * Stitch — TypeScript → Ruby integration tests
 * Run with: vitest run
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as os from 'os';

// ── Minimal bridge client (self-contained so tests don't depend on template) ──

const SIDECAR = path.join(__dirname, 'test-child.rb');

interface RpcSuccess { id: string; result: Record<string, unknown> }
interface RpcError   { id: string; error: { message: string; backtrace: string } }
type RpcResponse = RpcSuccess | RpcError;
type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

class RubyBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private buffer  = '';
  private ready   = false;

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child = spawn('ruby', [SIDECAR], { stdio: ['pipe', 'pipe', 'inherit'] });

      this.child.on('error', (err) => reject(new Error(`spawn failed: ${err.message}`)));

      this.child.on('exit', (code, sig) => {
        const msg = `sidecar exited (code=${code}, signal=${sig})`;
        for (const p of this.pending.values()) p.reject(new Error(msg));
        this.pending.clear();
        this.ready = false;
        this.child = null;
      });

      this.child.stdout.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let msg: Record<string, unknown>;
          try { msg = JSON.parse(trimmed); } catch { continue; }

          if (!this.ready && (msg as { ready?: boolean }).ready === true) {
            this.ready = true;
            resolve();
            continue;
          }

          const resp = msg as unknown as RpcResponse;
          const p = this.pending.get(resp.id);
          if (!p) continue;
          this.pending.delete(resp.id);

          if ('error' in resp) {
            const e = new Error(resp.error.message);
            (e as Error & { backtrace?: string }).backtrace = resp.error.backtrace;
            p.reject(e);
          } else {
            p.resolve(resp.result);
          }
        }
      });
    });
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.child || !this.ready) throw new Error('not started');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', 'utf8');
    });
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;

    if (os.platform() === 'win32') {
      child.kill();
    } else {
      child.kill('SIGTERM');
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /**/ } }, 2000);
      t.unref();
    }
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('TypeScript → Ruby bridge', () => {
  const bridge = new RubyBridge();

  beforeAll(async () => {
    await bridge.start();
  }, 15_000 /* generous timeout for slow CI ruby startup */);

  afterAll(() => {
    bridge.stop();
  });

  // ── echo ──────────────────────────────────────────────────────────────────

  it('echo — round-trip params unchanged', async () => {
    const params = { greeting: 'hello', count: 42, nested: { ok: true } };
    const result = await bridge.call('echo', params);
    expect(result).toEqual(params);
  });

  // ── add ───────────────────────────────────────────────────────────────────

  it('add — returns correct sum for integers', async () => {
    const result = await bridge.call('add', { a: 17, b: 25 });
    expect(result).toEqual({ sum: 42 });
  });

  it('add — returns correct sum for floats', async () => {
    const result = await bridge.call('add', { a: 1.5, b: 2.5 });
    expect((result as { sum: number }).sum).toBeCloseTo(4.0);
  });

  // ── concurrency ───────────────────────────────────────────────────────────

  it('concurrency — 10 in-flight calls resolve independently', async () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      bridge.call('add', { a: i, b: i })
    );
    const results = await Promise.all(calls);
    results.forEach((r, i) => {
      expect((r as { sum: number }).sum).toBe(i + i);
    });
  });

  // ── error bubbling ────────────────────────────────────────────────────────

  it('raise_error — rejects with message and backtrace', async () => {
    await expect(
      bridge.call('raise_error', { message: 'boom from ruby' })
    ).rejects.toSatisfy((err: Error & { backtrace?: string }) => {
      expect(err.message).toBe('boom from ruby');
      expect(typeof err.backtrace).toBe('string');
      expect(err.backtrace!.length).toBeGreaterThan(0);
      return true;
    });
  });

  it('raise_error — unknown method bubbles as error, not crash', async () => {
    await expect(
      bridge.call('no_such_method', {})
    ).rejects.toThrow(/Unknown method/);
  });

  // ── Base64 round-trip ─────────────────────────────────────────────────────

  it('echo_b64 — ASCII string round-trips correctly', async () => {
    const input = 'Stitch rocks!';
    const result = await bridge.call('echo_b64', { input }) as {
      encoded: string;
      decoded: string;
    };
    expect(result.decoded).toBe(input);
    // Verify the encoded value is valid base64
    expect(Buffer.from(result.encoded, 'base64').toString('utf8')).toBe(input);
  });

  it('echo_b64 — binary-safe content (null bytes, high bytes)', async () => {
    // Pass a pre-encoded value and ensure it decodes back round-trip
    const input = '\x00\xFF\xFE binary \x01\x02\x03';
    const result = await bridge.call('echo_b64', { input }) as {
      encoded: string;
      decoded: string;
    };
    expect(result.decoded).toBe(input);
  });

  // ── slow (timing) ─────────────────────────────────────────────────────────

  it('slow — resolves after delay', async () => {
    const before = Date.now();
    const result = await bridge.call('slow', { ms: 100 });
    const elapsed = Date.now() - before;
    expect(result).toEqual({ done: true });
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('slow — multiple slow calls run concurrently (Ruby I/O threads)', async () => {
    // Each call sleeps 200 ms; if serialised they'd take ~600 ms total.
    // Ruby releases the GVL during sleep, so concurrent I/O should be fast.
    const before = Date.now();
    await Promise.all([
      bridge.call('slow', { ms: 200 }),
      bridge.call('slow', { ms: 200 }),
      bridge.call('slow', { ms: 200 }),
    ]);
    const elapsed = Date.now() - before;
    // Allow generous headroom for CI; if truly serialised this would be >550 ms
    expect(elapsed).toBeLessThan(550);
  });

  // ── stdin-EOF defence ─────────────────────────────────────────────────────

  it('stdin-EOF — sidecar exits when stdin is closed', async () => {
    // Spin up a fresh sidecar, close its stdin, and confirm it exits.
    const child = spawn('ruby', [SIDECAR], { stdio: ['pipe', 'pipe', 'inherit'] });
    let readyReceived = false;

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.includes('"ready":true') || text.includes('"ready": true')) {
        readyReceived = true;
        // Close stdin to trigger watchdog
        child.stdin.end();
      }
    });

    const exitCode = await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('sidecar did not exit within 5 s after stdin close')), 5000)
      ),
    ]);

    expect(readyReceived).toBe(true);
    // exit 0 from the watchdog thread
    expect(exitCode).toBe(0);
  }, 10_000);
});
