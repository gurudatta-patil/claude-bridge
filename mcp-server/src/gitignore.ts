/**
 * gitignore.ts - inject Stitch output paths into the project .gitignore.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";

const MARKER_START = "# stitch-start";
const MARKER_END = "# stitch-end";

const MANAGED_ENTRIES = [
  ".stitch/bridges/.venv/",
  ".stitch/shared/",
  ".stitch/bridges/*_sidecar/target/",
  ".stitch/bridges/*_sidecar/*.exe",
  ".stitch/bridges/*.exe",
];

/**
 * Ensure `.stitch/` paths are present in `<projectRoot>/.gitignore`.
 * Idempotent - calling it multiple times is safe.
 */
export function ensureGitignore(projectRoot: string): void {
  const gitignorePath = path.join(projectRoot, ".gitignore");

  let existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";

  // Strip any previously managed block so we can rewrite it cleanly.
  const blockRe = new RegExp(
    `\n?${escapeRe(MARKER_START)}[\\s\\S]*?${escapeRe(MARKER_END)}\n?`,
    "g",
  );
  existing = existing.replace(blockRe, "");

  const block = [
    MARKER_START,
    ...MANAGED_ENTRIES,
    MARKER_END,
  ].join("\n");

  const newContent =
    existing.trimEnd() + (existing.trimEnd() ? "\n\n" : "") + block + "\n";

  writeFileSync(gitignorePath, newContent, "utf8");
}

/**
 * Remove the managed Stitch block from `.gitignore`.
 * Used in tests to restore the file to its original state.
 */
export function removeGitignoreBlock(projectRoot: string): void {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (!existsSync(gitignorePath)) return;

  const content = readFileSync(gitignorePath, "utf8");
  const blockRe = new RegExp(
    `\n?${escapeRe(MARKER_START)}[\\s\\S]*?${escapeRe(MARKER_END)}\n?`,
    "g",
  );
  writeFileSync(gitignorePath, content.replace(blockRe, ""), "utf8");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
