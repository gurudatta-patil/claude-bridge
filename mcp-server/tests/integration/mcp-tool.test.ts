/**
 * Integration test: scaffold-only tool pipeline.
 *
 * - Does NOT mock generateBridge (it no longer exists).
 * - Mocks `ensureVenv` + `installDeps` (venv.ts) to skip real venv creation.
 * - Calls `handleSetupStitch` with pre-baked fixture code.
 * - Verifies files are written, paths are patched, .gitignore is updated.
 * - Restores everything (temp dir deleted) in afterEach.
 */

import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../fixtures");

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../src/venv.js", () => ({
  ensureVenv: vi.fn(async () => undefined),
  installDeps: vi.fn(async () => undefined),
  venvPython: vi.fn(() => "/mock/python"),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

const { handleSetupStitch, handleGetTemplates } = await import("../../src/tool.js");
const { ensureVenv, installDeps } = await import("../../src/venv.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_PY = readFileSync(path.join(FIXTURES, "valid-python.py"), "utf8");
const VALID_TS = readFileSync(path.join(FIXTURES, "valid-typescript.ts"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `stitch-intg-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("handleSetupStitch (integration)", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes TypeScript client and Python sidecar files", async () => {
    const result = await handleSetupStitch({
      bridge_name: "test_bridge",
      language_pair: "typescript-python",
      client_code: VALID_TS,
      sidecar_code: VALID_PY,
      dependencies: [],
      project_root: dir,
    });

    expect(result.client_path).toMatch(/test_bridge\.ts$/);
    expect(result.sidecar_path).toMatch(/test_bridge\.py$/);
    expect(existsSync(result.client_path)).toBe(true);
    expect(existsSync(result.sidecar_path)).toBe(true);
  });

  test("Python sidecar path is patched to ../shared", async () => {
    // Inline code that has the repo-style path (what Claude might generate).
    const sidecarWithRepoPath = [
      "import sys as _sys",
      "_rpc_out = _sys.stdout",
      "_sys.stdout = _sys.stderr",
      "HANDLERS = {}",
      "import sys as _sys2",
      "import os as _os",
      "_sys2.path.insert(0, _os.path.join(_os.path.dirname(__file__), '..', '..', 'shared', 'python_sidecar'))",
      "from sidecar_base import run_sidecar, set_rpc_out",
      "set_rpc_out(_rpc_out)",
      "if __name__ == '__main__': run_sidecar(HANDLERS)",
    ].join("\n");

    const result = await handleSetupStitch({
      bridge_name: "path_bridge",
      language_pair: "typescript-python",
      client_code: VALID_TS,
      sidecar_code: sidecarWithRepoPath,
      dependencies: [],
      project_root: dir,
    });

    const py = readFileSync(result.sidecar_path, "utf8");
    expect(py).toContain("'..', 'shared'");
    expect(py).not.toContain("python_sidecar");
  });

  test("TypeScript client import path is patched to ../shared", async () => {
    // Inline code with the old repo-style import path.
    const clientWithRepoPath = [
      'import { spawn } from "child_process";',
      'import { BridgeClientBase, RpcRequest, killChild } from "../../shared/typescript/bridge-client-base";',
      'export class Stitch extends BridgeClientBase {',
      '  destroy() { killChild(null as never); }',
      '  protected _writeRequest(r: RpcRequest, id: string, reject: (e: Error) => void) {}',
      '}',
    ].join("\n");

    const result = await handleSetupStitch({
      bridge_name: "ts_path_bridge",
      language_pair: "typescript-python",
      client_code: clientWithRepoPath,
      sidecar_code: VALID_PY,
      dependencies: [],
      project_root: dir,
    });

    const ts = readFileSync(result.client_path, "utf8");
    expect(ts).toContain('../shared/bridge-client-base"');
    expect(ts).not.toContain("shared/typescript/");
  });

  test("shared helpers are copied into .stitch/shared/", async () => {
    await handleSetupStitch({
      bridge_name: "shared_bridge",
      language_pair: "typescript-python",
      client_code: VALID_TS,
      sidecar_code: VALID_PY,
      dependencies: [],
      project_root: dir,
    });

    const sharedDir = path.join(dir, ".stitch", "shared");
    expect(existsSync(path.join(sharedDir, "bridge-client-base.ts"))).toBe(true);
    expect(existsSync(path.join(sharedDir, "path-helpers.ts"))).toBe(true);
    expect(existsSync(path.join(sharedDir, "sidecar_base.py"))).toBe(true);
  });

  test("updates .gitignore with stitch block", async () => {
    await handleSetupStitch({
      bridge_name: "gi_bridge",
      language_pair: "typescript-python",
      client_code: VALID_TS,
      sidecar_code: VALID_PY,
      dependencies: [],
      project_root: dir,
    });

    const gi = readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gi).toContain("# stitch-start");
    expect(gi).toContain(".stitch/");
  });

  test("calls ensureVenv and installDeps", async () => {
    await handleSetupStitch({
      bridge_name: "venv_bridge",
      language_pair: "typescript-python",
      client_code: VALID_TS,
      sidecar_code: VALID_PY,
      dependencies: ["numpy"],
      project_root: dir,
    });

    expect(ensureVenv).toHaveBeenCalledOnce();
    expect(installDeps).toHaveBeenCalledWith(expect.any(String), ["numpy"]);
  });

  test("venv is placed at .stitch/bridges/.venv", async () => {
    await handleSetupStitch({
      bridge_name: "venv_check",
      language_pair: "typescript-python",
      client_code: VALID_TS,
      sidecar_code: VALID_PY,
      dependencies: [],
      project_root: dir,
    });

    expect(ensureVenv).toHaveBeenCalledWith(
      expect.stringContaining(path.join(".stitch", "bridges", ".venv")),
    );
  });

  test("result message contains bridge name and pair", async () => {
    const result = await handleSetupStitch({
      bridge_name: "my_bridge",
      language_pair: "typescript-python",
      client_code: VALID_TS,
      sidecar_code: VALID_PY,
      dependencies: [],
      project_root: dir,
    });

    expect(result.message).toContain("my_bridge");
    expect(result.message).toContain("typescript-python");
  });

  test("typescript-ruby generates .rb sidecar", async () => {
    const rubySidecar = [
      "# frozen_string_literal: true",
      "require_relative '../shared/sidecar_base'",
      "HANDLERS = {}.freeze",
      "run_sidecar(HANDLERS)",
    ].join("\n");

    const result = await handleSetupStitch({
      bridge_name: "ruby_bridge",
      language_pair: "typescript-ruby",
      client_code: VALID_TS,
      sidecar_code: rubySidecar,
      dependencies: [],
      project_root: dir,
    });

    expect(result.client_path).toMatch(/ruby_bridge\.ts$/);
    expect(result.sidecar_path).toMatch(/ruby_bridge\.rb$/);
  });
});

// ── handleGetTemplates ────────────────────────────────────────────────────────

describe("handleGetTemplates", () => {
  test("returns templates and slot docs for typescript-python", async () => {
    const result = await handleGetTemplates({ language_pair: "typescript-python" });

    expect(result.clientFenceTag).toBe("typescript");
    expect(result.sidecarFenceTag).toBe("python");
    expect(result.clientTemplate).toContain("[CLAUDE_TYPE_DEFINITIONS_HERE]");
    expect(result.sidecarTemplate).toContain("[CLAUDE_IMPORTS_HERE]");
    expect(result.clientSlots).toBeTruthy();
    expect(result.sidecarSlots).toBeTruthy();
  });

  test("returns templates for typescript-ruby", async () => {
    const result = await handleGetTemplates({ language_pair: "typescript-ruby" });

    expect(result.clientFenceTag).toBe("typescript");
    expect(result.sidecarFenceTag).toBe("ruby");
    expect(result.sidecarTemplate).toContain("run_sidecar");
  });

  test("throws for unknown language pair", async () => {
    await expect(handleGetTemplates({ language_pair: "cobol-fortran" } as never))
      .rejects.toThrow("Unknown language pair");
  });
});
