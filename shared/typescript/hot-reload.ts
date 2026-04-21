/**
 * Stitch hot-reload helper.
 *
 * Watches a sidecar source file for changes and restarts the bridge
 * transparently. Intended for development use only.
 *
 * Usage:
 *   import { withHotReload } from "../../shared/typescript/hot-reload";
 *
 *   const bridge = await withHotReload(
 *     async () => {
 *       const b = new PythonBridge("./sidecar.py");
 *       await b.start();
 *       return b;
 *     },
 *     "./sidecar.py",
 *     { debounce: 300 }
 *   );
 */

import { watch } from "fs";
import type { BridgeClientBase } from "./bridge-client-base";

export interface HotReloadOptions {
  /** Debounce delay in ms before restarting (default 300). */
  debounce?: number;
  /** Called each time the bridge is successfully restarted. */
  onReload?: () => void;
  /** Called on restart error. Default: logs to stderr. */
  onError?: (err: Error) => void;
}

/**
 * Returns a proxy that always forwards calls to the current live bridge.
 * When the watched file changes, the old bridge is stopped and a new one
 * is started via the factory function.
 */
export async function withHotReload<T extends BridgeClientBase>(
  factory: () => Promise<T>,
  watchPath: string,
  options: HotReloadOptions = {},
): Promise<T & { stopWatcher(): void }> {
  const { debounce = 300, onReload, onError } = options;

  let current = await factory();
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(watchPath, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      process.stderr.write(`[hot-reload] ${watchPath} changed – restarting bridge\n`);
      try {
        (current as unknown as { destroy?(): void }).destroy?.();
        current = await factory();
        onReload?.();
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        (onError ?? ((e: Error) => process.stderr.write(`[hot-reload] restart failed: ${e.message}\n`)))(e);
      }
    }, debounce);
  });

  // Create a proxy that always forwards property access to the current bridge instance
  const proxy = new Proxy({} as T & { stopWatcher(): void }, {
    get(_target, prop) {
      if (prop === "stopWatcher") return () => watcher.close();
      const val = (current as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof val === "function") return (val as (...args: unknown[]) => unknown).bind(current);
      return val;
    },
    set(_target, prop, value) {
      (current as unknown as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
  });

  return proxy;
}
