/**
 * Integration test: full tool pipeline with mocked code generator.
 *
 * - Mocks `generateBridge` (generator.ts) to return pre-baked fixture code.
 * - Mocks `ensureVenv` + `installDeps` (venv.ts) to skip real venv creation.
 * - Calls `handleGenerateGhostBridge` with a real temp project dir.
 * - Verifies files are written, .gitignore is updated, result shape is correct.
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
// Mock generateBridge so we never spawn `claude --print` in integration tests.

vi.mock("../../src/generator.js", () => ({
  generateBridge: vi.fn(),
}));

vi.mock("../../src/venv.js", () => ({
  ensureVenv: vi.fn(async () => undefined),
  installDeps: vi.fn(async () => undefined),
  venvPython: vi.fn(() => "/mock/python"),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

const { handleGenerateGhostBridge } = await import("../../src/tool.js");
const { generateBridge } = await import("../../src/generator.js");
const { ensureVenv, installDeps } = await import("../../src/venv.js");

// ── Fixtures (read after imports) ────────────────────────────────────────────

const VALID_PY = readFileSync(path.join(FIXTURES, "valid-python.py"), "utf8");
const VALID_TS = readFileSync(path.join(FIXTURES, "valid-typescript.ts"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `ghost-bridge-intg-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("handleGenerateGhostBridge (integration, mocked generator)", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    vi.clearAllMocks();
    // Re-apply mock return value after clearAllMocks.
    // New shape: { client, sidecar } (was { python, typescript }).
    (generateBridge as ReturnType<typeof vi.fn>).mockResolvedValue({
      client: VALID_TS,
      sidecar: VALID_PY,
      rawResponse: "",
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes TypeScript and Python files to .ghost-bridge/bridges/", async () => {
    const result = await handleGenerateGhostBridge({
      bridge_name: "test_bridge",
      target_capability: "echo and add two numbers",
      dependencies: [],
      project_root: dir,
    });

    expect(result.client_path).toMatch(/test_bridge\.ts$/);
    expect(result.sidecar_path).toMatch(/test_bridge\.py$/);
    expect(existsSync(result.client_path)).toBe(true);
    expect(existsSync(result.sidecar_path)).toBe(true);
  });

  test("written Python sidecar contains valid bridge code", async () => {
    const result = await handleGenerateGhostBridge({
      bridge_name: "echo_bridge",
      target_capability: "echo params",
      dependencies: [],
      project_root: dir,
    });

    const py = readFileSync(result.sidecar_path, "utf8");
    expect(py).toContain("_rpc_out = _sys.stdout");
  });

  test("written TypeScript client contains valid bridge code", async () => {
    const result = await handleGenerateGhostBridge({
      bridge_name: "echo_bridge",
      target_capability: "echo params",
      dependencies: [],
      project_root: dir,
    });

    const ts = readFileSync(result.client_path, "utf8");
    expect(ts).toContain("class GhostBridge");
  });

  test("updates .gitignore with ghost-bridge block", async () => {
    await handleGenerateGhostBridge({
      bridge_name: "gi_bridge",
      target_capability: "test gitignore",
      dependencies: [],
      project_root: dir,
    });

    const gi = readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gi).toContain("# ghost-bridge-start");
    expect(gi).toContain(".ghost-bridge/");
    expect(gi).toContain("# ghost-bridge-end");
  });

  test("calls ensureVenv and installDeps for typescript-python pair", async () => {
    await handleGenerateGhostBridge({
      bridge_name: "venv_bridge",
      target_capability: "uses numpy",
      dependencies: ["numpy"],
      project_root: dir,
    });

    expect(ensureVenv).toHaveBeenCalledOnce();
    expect(installDeps).toHaveBeenCalledWith(expect.any(String), ["numpy"]);
  });

  test("result message contains bridge name and pair", async () => {
    const result = await handleGenerateGhostBridge({
      bridge_name: "my_bridge",
      target_capability: "test",
      dependencies: [],
      project_root: dir,
    });

    expect(result.message).toContain("my_bridge");
    expect(result.message).toContain("typescript-python");
  });

  test("venv is placed inside .ghost-bridge/bridges/.venv", async () => {
    await handleGenerateGhostBridge({
      bridge_name: "venv_check",
      target_capability: "test",
      dependencies: [],
      project_root: dir,
    });

    expect(ensureVenv).toHaveBeenCalledWith(
      expect.stringContaining(path.join(".ghost-bridge", "bridges", ".venv")),
    );
  });

  test("non-default language_pair generates correct file extensions", async () => {
    // typescript-ruby: client = .ts, sidecar = .rb
    (generateBridge as ReturnType<typeof vi.fn>).mockResolvedValue({
      client: VALID_TS,
      sidecar: `# frozen_string_literal: true\nrequire_relative '../shared/sidecar_base'\nHANDLERS = {}.freeze\nrun_sidecar(HANDLERS)\n`,
      rawResponse: "",
    });

    const result = await handleGenerateGhostBridge({
      bridge_name: "ruby_bridge",
      target_capability: "test ruby",
      dependencies: [],
      language_pair: "typescript-ruby",
      project_root: dir,
    });

    expect(result.client_path).toMatch(/ruby_bridge\.ts$/);
    expect(result.sidecar_path).toMatch(/ruby_bridge\.rb$/);
  });
});
