/**
 * BridgePool - route calls across N bridge instances for parallel execution.
 */
import { BridgeClientBase } from "./bridge-client-base";

export class BridgePool<T extends BridgeClientBase> {
  private workers: T[] = [];
  private inFlight: number[] = [];
  private readonly size: number;

  constructor(
    private readonly factory: () => T,
    options: { size?: number } = {}
  ) {
    this.size = options.size ?? 4;
  }

  async start(): Promise<void> {
    this.workers = Array.from({ length: this.size }, () => this.factory());
    this.inFlight = new Array(this.size).fill(0);
    await Promise.all(this.workers.map((w) => (w as any).start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => (w as any).stop?.() ?? (w as any).destroy?.()));
    this.workers = [];
    this.inFlight = [];
  }

  /** Route a call to the least-busy worker. */
  protected pickWorker(): T {
    let minIdx = 0;
    for (let i = 1; i < this.inFlight.length; i++) {
      if (this.inFlight[i] < this.inFlight[minIdx]) minIdx = i;
    }
    return this.workers[minIdx];
  }

  protected trackCall<R>(workerIdx: number, p: Promise<R>): Promise<R> {
    this.inFlight[workerIdx]++;
    return p.finally(() => { this.inFlight[workerIdx]--; });
  }
}
