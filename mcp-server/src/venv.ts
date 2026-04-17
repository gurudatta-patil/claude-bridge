/**
 * venv.ts — Python virtual-environment management.
 *
 * Tries `uv` first (fast), falls back to `python -m venv`.
 */

import { execFile as _execFile, ExecFileOptions } from "child_process";
import { existsSync } from "fs";
import { platform } from "os";
import * as path from "path";
import { promisify } from "util";

const execFile = promisify(_execFile);

/** Returns the path to the Python executable inside a venv. */
export function venvPython(venvDir: string): string {
  return platform() === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

const EXEC_OPTS: ExecFileOptions = { timeout: 120_000 };

/**
 * Create a virtual environment at `venvDir` if it doesn't already exist.
 * Prefers `uv venv`; falls back to `python -m venv`.
 */
export async function ensureVenv(venvDir: string): Promise<void> {
  if (existsSync(venvPython(venvDir))) return; // already set up

  const hasUv = await commandExists("uv");
  if (hasUv) {
    await execFile("uv", ["venv", venvDir], EXEC_OPTS);
  } else {
    await execFile("python3", ["-m", "venv", venvDir], EXEC_OPTS);
  }
}

/**
 * Install Python packages into the venv.
 * Prefers `uv pip install`; falls back to `pip install`.
 */
export async function installDeps(
  venvDir: string,
  packages: string[],
): Promise<void> {
  if (packages.length === 0) return;

  const python = venvPython(venvDir);
  const hasUv = await commandExists("uv");

  if (hasUv) {
    await execFile(
      "uv",
      ["pip", "install", "--python", python, ...packages],
      EXEC_OPTS,
    );
  } else {
    await execFile(python, ["-m", "pip", "install", "--quiet", ...packages], EXEC_OPTS);
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFile(cmd, ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
