/**
 * Stitch — TypeScript path resolution helpers.
 *
 * Provides canonical ways to find the Python venv executable and
 * locate a compiled binary for any language target (Go, Rust, …).
 */

import { existsSync } from "fs";
import { platform } from "os";
import * as path from "path";

/**
 * Resolve the Python executable for a bridge.
 *
 * Checks for a `.venv` virtualenv adjacent to `bridgeRoot`.
 * Falls back to `python3` if no venv is found.
 *
 * @param bridgeRoot  Directory that may contain a `.venv/` subfolder.
 */
export function getVenvPython(bridgeRoot: string): string {
  const isWin = platform() === "win32";
  const venvBin = isWin
    ? path.join(bridgeRoot, ".venv", "Scripts", "python.exe")
    : path.join(bridgeRoot, ".venv", "bin", "python");

  if (existsSync(venvBin)) return venvBin;
  return "python3";
}

/**
 * Resolve the path to a compiled binary inside a bridge directory.
 *
 * Automatically appends `.exe` on Windows.
 *
 * @param bridgeRoot  Root of the bridge project (e.g. `.stitch/go/my-bridge`).
 * @param subdir      Subdirectory path relative to `bridgeRoot` (e.g. `"target/release"`).
 * @param name        Binary name without extension.
 *
 * @example
 *   getBinaryPath("/project/.stitch/rust/my-bridge", "target/release", "my-bridge")
 *   // → "/project/.stitch/rust/my-bridge/target/release/my-bridge"     (POSIX)
 *   // → "/project/.stitch/rust/my-bridge/target/release/my-bridge.exe" (Windows)
 */
export function getBinaryPath(
  bridgeRoot: string,
  subdir: string,
  name: string,
): string {
  const ext = platform() === "win32" ? ".exe" : "";
  return path.join(bridgeRoot, subdir, `${name}${ext}`);
}
