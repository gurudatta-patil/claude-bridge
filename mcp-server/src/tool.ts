/**
 * tool.ts — two MCP tool handlers for Stitch (scaffold-only design).
 *
 * Workflow:
 *   1. Claude Code calls get_stitch_templates(language_pair)
 *      → receives raw template files + slot documentation
 *   2. Claude Code fills in the slots in its own context (no subprocess)
 *   3. Claude Code calls setup_stitch(..., client_code, sidecar_code)
 *      → MCP writes files, patches paths, copies shared helpers, sets up runtime
 *
 * The MCP never calls `claude --print`. All code generation happens in
 * Claude Code's main context where it has full project visibility.
 */

import { mkdirSync, statSync, writeFileSync, readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ensureGitignore } from "./gitignore.js";
import { getTemplatesForPair } from "./generator.js";
import { getPairDef } from "./language-pair.js";
import type { PairDef } from "./language-pair.js";

const __filename = fileURLToPath(import.meta.url);

// ── Handler 1: get_stitch_templates ────────────────────────────────────

export interface GetTemplatesParams {
  language_pair: string;
}

export interface GetTemplatesResult {
  clientTemplate: string;
  sidecarTemplate: string;
  clientSlots: string;
  sidecarSlots: string;
  clientFenceTag: string;
  sidecarFenceTag: string;
}

export async function handleGetTemplates(
  params: GetTemplatesParams,
): Promise<GetTemplatesResult> {
  const repoRoot = resolveRepoRoot();
  return getTemplatesForPair(repoRoot, params.language_pair);
}

// ── Handler 2: setup_stitch ────────────────────────────────────────────

export interface SetupParams {
  bridge_name: string;
  language_pair?: string;
  /** Filled-in client source code (TypeScript, Python, Go, or Rust). */
  client_code: string;
  /** Filled-in sidecar source code (Python, Ruby, Go, Rust, or Node.js). */
  sidecar_code: string;
  dependencies: string[];
  /** Project root where .stitch/ will be written. Defaults to cwd. */
  project_root?: string;
}

export interface SetupResult {
  message: string;
  client_path: string;
  sidecar_path: string;
  runtime_info: string;
}

/** Extension for each client language's primary output file. */
const CLIENT_EXT: Record<string, string> = {
  typescript: ".ts",
  python: ".py",
  go: ".go",
  rust: ".rs",
};

/** Extension for each sidecar language's primary output file. */
const SIDECAR_EXT: Record<string, string> = {
  python: ".py",
  ruby: ".rb",
  nodejs: ".js",
  go: ".go",
  rust: ".rs",
};

export async function handleSetupStitch(
  params: SetupParams,
): Promise<SetupResult> {
  const repoRoot = resolveRepoRoot();
  const projectRoot = path.resolve(params.project_root ?? process.cwd());
  const languagePair = params.language_pair ?? "typescript-python";
  const { bridge_name, client_code, sidecar_code, dependencies } = params;

  const def: PairDef = getPairDef(languagePair);

  const bridgesDir = path.join(projectRoot, ".stitch", "bridges");
  mkdirSync(bridgesDir, { recursive: true });

  // 1. Copy shared helpers for client + sidecar languages.
  def.setupClient(repoRoot, projectRoot, bridgesDir);

  // 2. Patch import paths and write primary bridge files.
  const clientExt = CLIENT_EXT[def.clientLang] ?? ".txt";
  const sidecarExt = SIDECAR_EXT[def.sidecarLang] ?? ".txt";

  const clientPath = path.join(bridgesDir, `${bridge_name}${clientExt}`);
  writeFileSync(clientPath, def.patchClient(client_code, bridge_name) + "\n", "utf8");

  // For compiled sidecars (Go, Rust) the sidecar files go in their own subdir.
  let sidecarPath: string;
  if (def.sidecarLang === "go" || def.sidecarLang === "rust") {
    const sidecarSubdir = path.join(bridgesDir, bridge_name + "_sidecar");
    const srcDir =
      def.sidecarLang === "rust"
        ? path.join(sidecarSubdir, "src")
        : sidecarSubdir;
    mkdirSync(srcDir, { recursive: true });
    sidecarPath = path.join(srcDir, "main" + sidecarExt);
    writeFileSync(sidecarPath, def.patchSidecar(sidecar_code, bridge_name) + "\n", "utf8");

    // Write auxiliary files (go.mod / Cargo.toml).
    if (def.sidecarAuxTemplates) {
      for (const [templateRel, outputRel] of def.sidecarAuxTemplates) {
        const auxSrc = readFileSync(
          path.join(repoRoot, "bridges", languagePair, templateRel),
          "utf8",
        );
        const patched = def.patchAux
          ? def.patchAux(path.basename(outputRel), auxSrc, bridge_name)
          : auxSrc;
        const destPath = path.join(sidecarSubdir, outputRel);
        mkdirSync(path.dirname(destPath), { recursive: true });
        writeFileSync(destPath, patched + "\n", "utf8");
      }
    }
  } else {
    sidecarPath = path.join(bridgesDir, `${bridge_name}${sidecarExt}`);
    writeFileSync(sidecarPath, def.patchSidecar(sidecar_code, bridge_name) + "\n", "utf8");
  }

  // 3. Set up sidecar runtime (venv / build / gem install).
  const runtimeInfo = await def.setupSidecar(
    repoRoot,
    projectRoot,
    bridgesDir,
    bridge_name,
    dependencies,
  );

  // 4. .gitignore
  ensureGitignore(projectRoot);

  return {
    message: `Stitch "${bridge_name}" (${languagePair}) scaffolded successfully.`,
    client_path: clientPath,
    sidecar_path: sidecarPath,
    runtime_info: runtimeInfo,
  };
}

// ── Shared helper ─────────────────────────────────────────────────────────────

/** Walk up from __filename until we find a directory that contains bridges/. */
export function resolveRepoRoot(): string {
  let dir = path.dirname(__filename);
  for (let i = 0; i < 6; i++) {
    const candidate = path.resolve(dir);
    try {
      statSync(path.join(candidate, "bridges"));
      return candidate;
    } catch {
      dir = path.join(dir, "..");
    }
  }
  throw new Error(
    "Could not locate stitch repo root (bridges/ directory not found)",
  );
}
