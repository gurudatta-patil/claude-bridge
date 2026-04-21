/**
 * language-pair.ts - per-pair configuration for all 13 Stitch pairs.
 *
 * Each PairDef describes:
 *   - which template files to read for the client and sidecar
 *   - which shared helpers to copy into .stitch/shared/
 *   - how to patch import paths in generated code
 *   - how to set up the sidecar runtime (venv / cargo build / go build / gem)
 *   - which code-fence language tags Claude should output
 *   - how to validate the generated code
 *
 * Bugs from the typescript-python experience that are handled here:
 *   1. Python sidecar path: use /.*?/s regex so nested parens don't break it.
 *   2. Venv lives at bridgesDir/.venv so getVenvPython(scriptDir) finds it.
 *   3. Ruby require_relative always points to ../shared/sidecar_base.
 *   4. Go/Rust sidecars get a proper go.mod / Cargo.toml with local paths.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { execFile as _execFile } from "child_process";
import * as path from "path";
import * as os from "os";
import { promisify } from "util";
import { ensureVenv, installDeps } from "./venv.js";

const execFile = promisify(_execFile);

// ── Public types ─────────────────────────────────────────────────────────────

export type ClientLang = "typescript" | "go" | "python" | "rust";
export type SidecarLang = "python" | "ruby" | "nodejs" | "go" | "rust";

export type LanguagePairName =
  | "typescript-python"
  | "typescript-ruby"
  | "typescript-rust"
  | "typescript-go"
  | "go-python"
  | "go-ruby"
  | "go-nodejs"
  | "go-rust"
  | "python-go"
  | "python-ruby"
  | "python-rust"
  | "python-nodejs"
  | "rust-go"
  | "rust-python"
  | "rust-ruby"
  | "rust-nodejs";

export const ALL_PAIRS: LanguagePairName[] = [
  "typescript-python",
  "typescript-ruby",
  "typescript-rust",
  "typescript-go",
  "go-python",
  "go-ruby",
  "go-nodejs",
  "go-rust",
  "python-go",
  "python-ruby",
  "python-rust",
  "python-nodejs",
  "rust-go",
  "rust-python",
  "rust-ruby",
  "rust-nodejs",
];

/** Code-fence language tag for each language. */
export const FENCE_TAG: Record<ClientLang | SidecarLang, string> = {
  typescript: "typescript",
  python: "python",
  ruby: "ruby",
  nodejs: "javascript",
  go: "go",
  rust: "rust",
};

export interface PairDef {
  clientLang: ClientLang;
  sidecarLang: SidecarLang;
  /** Path to the primary client template, relative to bridges/<pair>/ */
  clientTemplate: string;
  /** Path to the primary sidecar template, relative to bridges/<pair>/ */
  sidecarTemplate: string;
  /**
   * Auxiliary sidecar files (go.mod, Cargo.toml) to read and write alongside
   * the primary template. Each entry: [templateRelPath, outputRelPath].
   * The output is relative to the per-bridge sidecar directory in .stitch.
   */
  sidecarAuxTemplates?: [string, string][];
  /** Slot marker documentation shown to Claude. */
  clientSlots: string;
  sidecarSlots: string;
  /** Patch generated client code before writing. */
  patchClient(code: string, bridgeName: string): string;
  /** Patch generated sidecar code before writing. */
  patchSidecar(code: string, bridgeName: string): string;
  /** Patch auxiliary sidecar file content before writing. */
  patchAux?(filename: string, code: string, bridgeName: string): string;
  /**
   * Copy shared helpers and set up the sidecar runtime.
   * Returns a human-readable summary of what was set up.
   */
  setupSidecar(
    repoRoot: string,
    projectRoot: string,
    bridgesDir: string,
    bridgeName: string,
    dependencies: string[],
  ): Promise<string>;
  /** Copy shared helpers for the client language. */
  setupClient(repoRoot: string, projectRoot: string, bridgesDir: string): void;
}

// ── Shared helper: copy one file, creating dest dir as needed ────────────────

function cp(src: string, dest: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function write(dest: string, content: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, content, "utf8");
}

// ── Per-client-language client setup ─────────────────────────────────────────

function setupTypeScriptClient(
  repoRoot: string,
  sharedDir: string,
): void {
  const tsShared = path.join(repoRoot, "shared", "typescript");
  cp(
    path.join(tsShared, "bridge-client-base.ts"),
    path.join(sharedDir, "bridge-client-base.ts"),
  );
  cp(
    path.join(tsShared, "path-helpers.ts"),
    path.join(sharedDir, "path-helpers.ts"),
  );
}

function setupPythonClient(repoRoot: string, sharedDir: string): void {
  cp(
    path.join(repoRoot, "shared", "python", "bridge_client.py"),
    path.join(sharedDir, "bridge_client.py"),
  );
}

/** Rust bridge_client is inlined as a mod in src/main.rs - nothing to copy. */
function setupRustClient(_repoRoot: string, _sharedDir: string): void {}

/**
 * Go client needs shared/go/bridge_client.go + a go.mod in the shared dir
 * so the replace directive in the bridge go.mod resolves.
 */
function setupGoClient(repoRoot: string, sharedDir: string, bridgesDir: string): void {
  const goSharedDir = path.join(sharedDir, "go");
  mkdirSync(goSharedDir, { recursive: true });
  cp(
    path.join(repoRoot, "shared", "go", "bridge_client.go"),
    path.join(goSharedDir, "bridge_client.go"),
  );
  // Write go.mod so Go toolchain can resolve the shared module.
  write(
    path.join(goSharedDir, "go.mod"),
    "module github.com/stitch/shared/go\n\ngo 1.21\n",
  );
  // Write go.mod for the generated bridge file so `go build` resolves deps.
  const bridgesGoMod = path.join(bridgesDir, "go.mod");
  if (!existsSync(bridgesGoMod)) {
    write(
      bridgesGoMod,
      "module github.com/stitch/bridge\n\ngo 1.21\n\nrequire (\n\tgithub.com/google/uuid v1.6.0\n\tgithub.com/stitch/shared/go v0.0.0\n)\n\nreplace github.com/stitch/shared/go => ./shared/go\n",
    );
  }
}

// ── Per-sidecar-language sidecar setup ───────────────────────────────────────

async function setupPythonSidecar(
  repoRoot: string,
  sharedDir: string,
  bridgesDir: string,
  _bridgeName: string,
  deps: string[],
): Promise<string> {
  cp(
    path.join(repoRoot, "shared", "python_sidecar", "sidecar_base.py"),
    path.join(sharedDir, "sidecar_base.py"),
  );
  const venvDir = path.join(bridgesDir, ".venv");
  await ensureVenv(venvDir);
  await installDeps(venvDir, deps);
  return `Python venv: ${venvDir}`;
}

async function setupRubySidecar(
  repoRoot: string,
  sharedDir: string,
  _bridgesDir: string,
  _bridgeName: string,
  deps: string[],
): Promise<string> {
  cp(
    path.join(repoRoot, "shared", "ruby_sidecar", "sidecar_base.rb"),
    path.join(sharedDir, "sidecar_base.rb"),
  );
  if (deps.length > 0) {
    const gemArgs = ["install", "--no-document", ...deps];
    await execFile("gem", gemArgs, { timeout: 120_000 });
  }
  return deps.length > 0 ? `Ruby gems installed: ${deps.join(", ")}` : "Ruby stdlib only";
}

async function setupNodeJsSidecar(
  _repoRoot: string,
  _sharedDir: string,
  _bridgesDir: string,
  _bridgeName: string,
  deps: string[],
): Promise<string> {
  // Node.js sidecar uses built-in readline - no shared helper to copy.
  if (deps.length > 0) {
    // If the user lists npm packages, install them via a temporary package.json.
    // In practice most Node sidecars need no external deps.
    return `Note: Node.js deps ${deps.join(", ")} must be installed manually (npm install).`;
  }
  return "Node.js stdlib only";
}

/**
 * Go sidecar: copy shared go_sidecar, write a go.mod for it, update the
 * bridge go.mod with a replace directive, then go build.
 */
async function setupGoSidecar(
  repoRoot: string,
  sharedDir: string,
  bridgesDir: string,
  bridgeName: string,
  _deps: string[],
): Promise<string> {
  const goSidecarShared = path.join(sharedDir, "go_sidecar");
  mkdirSync(goSidecarShared, { recursive: true });
  cp(
    path.join(repoRoot, "shared", "go_sidecar", "sidecar.go"),
    path.join(goSidecarShared, "sidecar.go"),
  );
  write(
    path.join(goSidecarShared, "go.mod"),
    "module github.com/stitch/shared/go_sidecar\n\ngo 1.21\n",
  );

  const bridgeDir = path.join(bridgesDir, bridgeName + "_sidecar");
  const goModPath = path.join(bridgeDir, "go.mod");
  if (existsSync(goModPath)) {
    let goMod = readFileSync(goModPath, "utf8");
    if (!goMod.includes("stitch/shared/go_sidecar")) {
      goMod = goMod.trimEnd() + "\n\nrequire github.com/stitch/shared/go_sidecar v0.0.0\n\nreplace github.com/stitch/shared/go_sidecar => ../shared/go_sidecar\n";
      writeFileSync(goModPath, goMod, "utf8");
    }
  }

  const binName = bridgeName + (os.platform() === "win32" ? ".exe" : "");
  const binPath = path.join(bridgeDir, binName);
  await execFile("go", ["build", "-o", binPath, "."], {
    cwd: bridgeDir,
    timeout: 120_000,
  });
  return `Go sidecar binary: ${binPath}`;
}

/**
 * Rust sidecar: copy rust_sidecar crate, write its Cargo.toml, add a
 * path dependency in the bridge Cargo.toml, then cargo build --release.
 */
async function setupRustSidecar(
  repoRoot: string,
  sharedDir: string,
  bridgesDir: string,
  bridgeName: string,
  _deps: string[],
): Promise<string> {
  const rustSidecarShared = path.join(sharedDir, "rust_sidecar", "src");
  mkdirSync(rustSidecarShared, { recursive: true });
  cp(
    path.join(repoRoot, "shared", "rust_sidecar", "src", "lib.rs"),
    path.join(rustSidecarShared, "lib.rs"),
  );
  write(
    path.join(sharedDir, "rust_sidecar", "Cargo.toml"),
    `[package]\nname = "stitch_sidecar"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\n`,
  );

  const bridgeDir = path.join(bridgesDir, bridgeName + "_sidecar");
  const cargoPath = path.join(bridgeDir, "Cargo.toml");
  if (existsSync(cargoPath)) {
    let cargo = readFileSync(cargoPath, "utf8");
    if (!cargo.includes("stitch_sidecar")) {
      cargo = cargo.trimEnd() + "\nstitch_sidecar = { path = \"../shared/rust_sidecar\" }\n";
      writeFileSync(cargoPath, cargo, "utf8");
    }
  }

  await execFile("cargo", ["build", "--release"], {
    cwd: bridgeDir,
    timeout: 300_000,
  });
  const ext = os.platform() === "win32" ? ".exe" : "";
  const binPath = path.join(bridgeDir, "target", "release", bridgeName + ext);
  return `Rust sidecar binary: ${binPath}`;
}

// ── Path patching helpers ─────────────────────────────────────────────────────

/** Fix Python sidecar sys.path for shared dir. Handles nested parens via /s flag. */
export function patchPythonSidecarPath(code: string): string {
  return code.replace(
    /_sys2\.path\.insert\(0,\s*_os\.path\.join\(.*?\)\)/s,
    "_sys2.path.insert(0, _os.path.join(_os.path.dirname(__file__), '..', 'shared'))",
  );
}

/** Fix Python client import path for bridge_client. */
export function patchPythonClientPath(code: string): string {
  // Insert sys.path adjustment before the first bridge_client import if not already present.
  if (!code.includes("stitch/shared") && !code.includes("../shared")) return code;
  return code.replace(
    /from\s+bridge_client\s+import/,
    "import sys as _sys_gb; import os as _os_gb\n_sys_gb.path.insert(0, _os_gb.path.join(_os_gb.path.dirname(__file__), '..', 'shared'))\nfrom bridge_client import",
  );
}

/** Fix TypeScript client shared imports to use ../shared/ relative path. */
export function patchTypeScriptImports(code: string): string {
  return code
    .replace(
      /from\s+["'].*?shared\/typescript\/bridge-client-base["']/g,
      'from "../shared/bridge-client-base"',
    )
    .replace(
      /from\s+["'].*?shared\/typescript\/path-helpers["']/g,
      'from "../shared/path-helpers"',
    );
}

/** Fix Ruby sidecar require_relative to use ../shared path. */
export function patchRubySidecarPath(code: string): string {
  return code.replace(
    /require_relative\s+['"].*?ruby_sidecar\/sidecar_base['"]/,
    "require_relative '../shared/sidecar_base'",
  );
}

// ── Per-pair slot documentation ───────────────────────────────────────────────

const PY_SIDECAR_SLOTS = `
PYTHON sidecar - fill ONLY these three slot comments:
  # [CLAUDE_IMPORTS_HERE]             → import statements (AFTER stdout redirect)
  # [CLAUDE_HANDLER_FUNCTIONS_HERE]   → one def per method, takes params:dict, returns dict
  # [CLAUDE_LOGIC_ROUTING_HERE]       → "method_name": handle_fn  entries in HANDLERS dict

Non-negotiable Python constraints:
  • First two executable lines MUST keep _rpc_out = _sys.stdout / _sys.stdout = _sys.stderr unchanged.
  • NEVER use print() or sys.stdout.write(). Only _rpc_out is allowed.
  • All third-party imports come AFTER the stdout redirect.`.trim();

const TS_CLIENT_SLOTS = `
TYPESCRIPT client - fill ONLY these two slot comments:
  // [CLAUDE_TYPE_DEFINITIONS_HERE]   → TypeScript interfaces / type aliases
  // [CLAUDE_PUBLIC_METHODS_HERE]     → public async methods that call this.call<T>(method, params)

Non-negotiable TypeScript constraints:
  • Keep the class name exactly as in the template.
  • Keep killChild() in destroy(). Keep this.call() signature unchanged.`.trim();

const RUBY_SIDECAR_SLOTS = `
RUBY sidecar - fill inside the HANDLERS hash using the slot marker as a guide:
  # [CLAUDE_HANDLERS]  →  'method_name' => lambda { |params| ... }  entries

Non-negotiable Ruby constraints:
  • Keep require_relative line for sidecar_base unchanged.
  • Keep run_sidecar(HANDLERS) at the end.
  • NEVER use puts or $stdout.write - sidecar_base handles all output.`.trim();

const GO_SIDECAR_SLOTS = `
GO sidecar - fill ONLY the TODO sections:
  // TODO: implement your methods here  →  case "method_name": branches in dispatch()
  // Also add top-level handler functions above dispatch().

Non-negotiable Go constraints:
  • Keep sidecar.SendReady(out), sidecar.NewScanner(), sidecar.SendResponse() calls unchanged.
  • Keep sidecar.InstallSignalHandler() in main().
  • Use sidecar.SidecarError{Code: -32602, Message: ...} for errors.`.trim();

const RUST_SIDECAR_SLOTS = `
RUST sidecar - fill ONLY these slot comments:
  // [CLAUDE_IMPORT_HANDLERS]  →  use statements for your handler modules
  // [CLAUDE_ADD_METHODS]      →  "method_name" => handler logic in the match arm
  // [CLAUDE_HANDLER_IMPLS]    →  fn definitions below main()

Non-negotiable Rust constraints:
  • Keep run_sidecar(|method, params| { ... }) wrapper unchanged.
  • Keep the wildcard arm Err(format!("unknown method: {method}")) unchanged.
  • Deserialise params with serde_json::from_value.`.trim();

const JS_SIDECAR_SLOTS = `
JAVASCRIPT (Node.js) sidecar - fill inside the handlers object:
  echo/add examples → replace with your actual method handlers

Non-negotiable Node.js constraints:
  • Keep process.stdout.write(JSON.stringify({ ready: true }) + '\\n') as the first output line.
  • Keep readline.createInterface on process.stdin and the rl.on('close') exit unchanged.
  • NEVER use console.log() - all output must go through process.stdout.write.`.trim();

const RUBY_CLIENT_SLOTS = `
(Python/TypeScript client - see CLIENT template above)
Ruby is the sidecar language for this pair; see RUBY sidecar slots.`.trim();

const GO_CLIENT_SLOTS = `
GO client - fill the TODO sections in template.client.go:
  SIDECAR_SCRIPT / PYTHON_BIN constants → replace with actual values
  Add your own bridge.Call("method", params) calls in main().

Non-negotiable Go constraints:
  • Keep stitch.WaitReady, stitch.PendingMap usage unchanged.
  • Keep bridge.Close() cleanup in main().`.trim();

const PY_CLIENT_SLOTS = `
PYTHON client - no slot markers needed. The generated class already works.
  Just add any extra methods to the bridge class if needed.`.trim();

const RUST_CLIENT_SLOTS = `
RUST client - fill ONLY these slot markers in src/main.rs:
  [CLAUDE_SIDECAR_PATH]   →  path to the sidecar binary/script
  [CLAUDE_METHOD]         →  method name to call in demo
  [CLAUDE_PARAMS]         →  JSON params for the demo call

Non-negotiable Rust constraints:
  • Keep the bridge_client mod block unchanged.
  • Keep PendingMap, kill_child, install_ctrlc_handler usage unchanged.`.trim();

// ── PairDef factory ───────────────────────────────────────────────────────────

type SidecarSetupFn = (
  repoRoot: string,
  sharedDir: string,
  bridgesDir: string,
  bridgeName: string,
  deps: string[],
) => Promise<string>;

const SIDECAR_SETUP: Record<SidecarLang, SidecarSetupFn> = {
  python: setupPythonSidecar,
  ruby: setupRubySidecar,
  nodejs: setupNodeJsSidecar,
  go: setupGoSidecar,
  rust: setupRustSidecar,
};

function makePairDef(
  clientLang: ClientLang,
  sidecarLang: SidecarLang,
  clientTemplate: string,
  sidecarTemplate: string,
  clientSlots: string,
  sidecarSlots: string,
  opts: {
    sidecarAuxTemplates?: [string, string][];
    patchClient?: (code: string, name: string) => string;
    patchSidecar?: (code: string, name: string) => string;
    patchAux?: (filename: string, code: string, name: string) => string;
  } = {},
): PairDef {
  return {
    clientLang,
    sidecarLang,
    clientTemplate,
    sidecarTemplate,
    sidecarAuxTemplates: opts.sidecarAuxTemplates,
    clientSlots,
    sidecarSlots,
    patchClient: opts.patchClient ?? ((c) => c),
    patchSidecar: opts.patchSidecar ?? ((c) => c),
    patchAux: opts.patchAux,
    async setupSidecar(repoRoot, projectRoot, bridgesDir, bridgeName, deps) {
      const sharedDir = path.join(projectRoot, ".stitch", "shared");
      mkdirSync(sharedDir, { recursive: true });
      return SIDECAR_SETUP[sidecarLang](repoRoot, sharedDir, bridgesDir, bridgeName, deps);
    },
    setupClient(repoRoot, projectRoot, _bridgesDir) {
      const sharedDir = path.join(projectRoot, ".stitch", "shared");
      mkdirSync(sharedDir, { recursive: true });
      if (clientLang === "typescript") setupTypeScriptClient(repoRoot, sharedDir);
      else if (clientLang === "python") setupPythonClient(repoRoot, sharedDir);
      else if (clientLang === "rust") setupRustClient(repoRoot, sharedDir);
      else if (clientLang === "go") setupGoClient(repoRoot, sharedDir, _bridgesDir);
    },
  };
}

// ── Rust Cargo.toml name substitution ─────────────────────────────────────────

function patchRustCargoName(code: string, bridgeName: string): string {
  // Replace template placeholder package name with actual bridge name.
  return code
    .replace(/name\s*=\s*"bridge_name"/g, `name = "${bridgeName}"`)
    .replace(/name\s*=\s*"template-sidecar"/g, `name = "${bridgeName}"`)
    .replace(/name\s*=\s*"go-bridge-client"/g, `name = "${bridgeName}-client"`)
    .replace(/name\s*=\s*"python-bridge-client"/g, `name = "${bridgeName}-client"`)
    .replace(/name\s*=\s*"ruby-bridge-client"/g, `name = "${bridgeName}-client"`)
    .replace(/\[\[bin\]\]\nname\s*=\s*"bridge_name"/g, `[[bin]]\nname = "${bridgeName}"`)
    .replace(/\[\[bin\]\]\nname\s*=\s*"template-sidecar"/g, `[[bin]]\nname = "${bridgeName}"`);
}

// ── The 13 pair definitions ───────────────────────────────────────────────────

export const PAIRS: Record<LanguagePairName, PairDef> = {
  "typescript-python": makePairDef(
    "typescript", "python",
    "template.client.ts", "template.sidecar.py",
    TS_CLIENT_SLOTS, PY_SIDECAR_SLOTS,
    {
      patchClient: patchTypeScriptImports,
      patchSidecar: patchPythonSidecarPath,
    },
  ),

  "typescript-ruby": makePairDef(
    "typescript", "ruby",
    "template.client.ts", "template.sidecar.rb",
    TS_CLIENT_SLOTS, RUBY_SIDECAR_SLOTS,
    {
      patchClient: patchTypeScriptImports,
      patchSidecar: patchRubySidecarPath,
    },
  ),

  "typescript-rust": makePairDef(
    "typescript", "rust",
    "template.client.ts", "template.sidecar/src/main.rs",
    TS_CLIENT_SLOTS, RUST_SIDECAR_SLOTS,
    {
      sidecarAuxTemplates: [
        ["template.sidecar/Cargo.toml", "Cargo.toml"],
      ],
      patchClient: patchTypeScriptImports,
      patchAux: (filename, code, name) =>
        filename === "Cargo.toml" ? patchRustCargoName(code, name) : code,
    },
  ),

  "typescript-go": makePairDef(
    "typescript", "go",
    "template.client.ts", "template.sidecar/main.go",
    TS_CLIENT_SLOTS, GO_SIDECAR_SLOTS,
    {
      sidecarAuxTemplates: [
        ["template.sidecar/go.mod", "go.mod"],
      ],
      patchClient: patchTypeScriptImports,
    },
  ),

  "go-python": makePairDef(
    "go", "python",
    "template.client.go", "template.sidecar.py",
    GO_CLIENT_SLOTS, PY_SIDECAR_SLOTS,
    {
      patchSidecar: patchPythonSidecarPath,
    },
  ),

  "go-ruby": makePairDef(
    "go", "ruby",
    "template.client.go", "template.sidecar.rb",
    GO_CLIENT_SLOTS, RUBY_SIDECAR_SLOTS,
    {
      patchSidecar: patchRubySidecarPath,
    },
  ),

  "go-nodejs": makePairDef(
    "go", "nodejs",
    "template.client.go", "template.sidecar.js",
    GO_CLIENT_SLOTS, JS_SIDECAR_SLOTS,
  ),

  "python-go": makePairDef(
    "python", "go",
    "template.client.py", "template.sidecar/main.go",
    PY_CLIENT_SLOTS, GO_SIDECAR_SLOTS,
    {
      sidecarAuxTemplates: [
        ["template.sidecar/go.mod", "go.mod"],
      ],
      patchClient: patchPythonClientPath,
    },
  ),

  "python-ruby": makePairDef(
    "python", "ruby",
    "template.client.py", "template.sidecar.rb",
    PY_CLIENT_SLOTS, RUBY_SIDECAR_SLOTS,
    {
      patchClient: patchPythonClientPath,
      patchSidecar: patchRubySidecarPath,
    },
  ),

  "python-rust": makePairDef(
    "python", "rust",
    "template.client.py", "template.sidecar/src/main.rs",
    PY_CLIENT_SLOTS, RUST_SIDECAR_SLOTS,
    {
      sidecarAuxTemplates: [
        ["template.sidecar/Cargo.toml", "Cargo.toml"],
      ],
      patchClient: patchPythonClientPath,
      patchAux: (filename, code, name) =>
        filename === "Cargo.toml" ? patchRustCargoName(code, name) : code,
    },
  ),

  "rust-go": makePairDef(
    "rust", "go",
    "template.client/src/main.rs", "template.sidecar/main.go",
    RUST_CLIENT_SLOTS, GO_SIDECAR_SLOTS,
    {
      sidecarAuxTemplates: [
        ["template.sidecar/go.mod", "go.mod"],
      ],
    },
  ),

  "rust-python": makePairDef(
    "rust", "python",
    "template.client/src/main.rs", "template.sidecar.py",
    RUST_CLIENT_SLOTS, PY_SIDECAR_SLOTS,
    {
      patchSidecar: patchPythonSidecarPath,
    },
  ),

  "rust-ruby": makePairDef(
    "rust", "ruby",
    "template.client/src/main.rs", "template.sidecar.rb",
    RUST_CLIENT_SLOTS, RUBY_SIDECAR_SLOTS,
    {
      patchSidecar: patchRubySidecarPath,
    },
  ),

  "go-rust": makePairDef(
    "go", "rust",
    "template.client.go", "template.sidecar/src/main.rs",
    GO_CLIENT_SLOTS, RUST_SIDECAR_SLOTS,
    {
      sidecarAuxTemplates: [
        ["template.sidecar/Cargo.toml", "Cargo.toml"],
      ],
      patchAux: (filename, code, name) =>
        filename === "Cargo.toml" ? patchRustCargoName(code, name) : code,
    },
  ),

  "python-nodejs": makePairDef(
    "python", "nodejs",
    "template.client.py", "template.sidecar.js",
    PY_CLIENT_SLOTS, JS_SIDECAR_SLOTS,
    {
      patchClient: patchPythonClientPath,
    },
  ),

  "rust-nodejs": makePairDef(
    "rust", "nodejs",
    "template.client/src/main.rs", "template.sidecar.js",
    RUST_CLIENT_SLOTS, JS_SIDECAR_SLOTS,
  ),
};

/** Look up a pair by name; throws a clear error for unknown names. */
export function getPairDef(name: string): PairDef {
  const def = PAIRS[name as LanguagePairName];
  if (!def) {
    throw new Error(
      `Unknown language pair: "${name}". Valid pairs: ${ALL_PAIRS.join(", ")}`,
    );
  }
  return def;
}
