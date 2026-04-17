/**
 * tool.ts — MCP tool handler for `generate_ghost_bridge`.
 *
 * Orchestration order:
 *   1. Resolve repo root (walks up from __filename looking for bridges/)
 *   2. Look up the language-pair descriptor (PairDef)
 *   3. Generate client + sidecar code via `claude --print`
 *   4. Copy shared helper modules into <projectRoot>/.ghost-bridge/shared/
 *   5. Patch import paths in generated files
 *   6. Write bridge files to .ghost-bridge/bridges/
 *   7. Write auxiliary sidecar files (go.mod, Cargo.toml) if any
 *   8. Set up sidecar runtime (venv / go build / cargo build / gem install)
 *   9. Inject .gitignore entries
 *
 * Copying shared modules into the project makes generated bridges fully
 * self-contained — they work regardless of where the project lives relative
 * to this repo.
 */

import { mkdirSync, statSync, writeFileSync, readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ensureGitignore } from "./gitignore.js";
import { generateBridge } from "./generator.js";
import { getPairDef } from "./language-pair.js";
import type { PairDef } from "./language-pair.js";

const __filename = fileURLToPath(import.meta.url);

export interface ToolParams {
  bridge_name: string;
  target_capability: string;
  dependencies: string[];
  /** Which language pair to generate, e.g. "typescript-python". Defaults to "typescript-python". */
  language_pair?: string;
  /** Project root where .ghost-bridge/ will be written. Defaults to cwd. */
  project_root?: string;
}

export interface ToolResult {
  message: string;
  client_path: string;
  sidecar_path: string;
  runtime_info: string;
}

/** Absolute path to the ghost-bridge repo root (where bridges/ lives). */
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
    "Could not locate ghost-bridge repo root (bridges/ directory not found)",
  );
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

export async function handleGenerateGhostBridge(
  params: ToolParams,
): Promise<ToolResult> {
  const repoRoot = resolveRepoRoot();
  const projectRoot = path.resolve(params.project_root ?? process.cwd());
  const languagePair = params.language_pair ?? "typescript-python";
  const { bridge_name, target_capability, dependencies } = params;

  const def: PairDef = getPairDef(languagePair);

  // 1. Generate code.
  const { client, sidecar } = await generateBridge({
    bridgeName: bridge_name,
    targetCapability: target_capability,
    dependencies,
    languagePair,
    repoRoot,
  });

  // 2. Copy shared modules for client + sidecar languages.
  const bridgesDir = path.join(projectRoot, ".ghost-bridge", "bridges");
  mkdirSync(bridgesDir, { recursive: true });

  def.setupClient(repoRoot, projectRoot, bridgesDir);

  // 3. Patch import paths and write primary bridge files.
  const clientExt = CLIENT_EXT[def.clientLang] ?? ".txt";
  const sidecarExt = SIDECAR_EXT[def.sidecarLang] ?? ".txt";

  const clientPath = path.join(bridgesDir, `${bridge_name}${clientExt}`);
  writeFileSync(clientPath, def.patchClient(client, bridge_name) + "\n", "utf8");

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
    writeFileSync(sidecarPath, def.patchSidecar(sidecar, bridge_name) + "\n", "utf8");

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
    writeFileSync(sidecarPath, def.patchSidecar(sidecar, bridge_name) + "\n", "utf8");
  }

  // 4. Set up sidecar runtime (venv / build / gem install).
  const runtimeInfo = await def.setupSidecar(
    repoRoot,
    projectRoot,
    bridgesDir,
    bridge_name,
    dependencies,
  );

  // 5. .gitignore
  ensureGitignore(projectRoot);

  return {
    message: `Ghost-Bridge "${bridge_name}" (${languagePair}) created successfully.`,
    client_path: clientPath,
    sidecar_path: sidecarPath,
    runtime_info: runtimeInfo,
  };
}
