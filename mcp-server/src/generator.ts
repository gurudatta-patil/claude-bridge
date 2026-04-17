/**
 * generator.ts — template reader for Stitch.
 *
 * The old version called `claude --print` internally (Claude calling itself).
 * This version is scaffold-only: it just reads template files from disk
 * and returns them so Claude Code can fill in the slots in its own context.
 */

import { readFileSync } from "fs";
import * as path from "path";
import { getPairDef, FENCE_TAG } from "./language-pair.js";

export interface TemplatesResult {
  /** Raw content of the client template file. */
  clientTemplate: string;
  /** Raw content of the sidecar template file. */
  sidecarTemplate: string;
  /** Slot documentation for the client language. */
  clientSlots: string;
  /** Slot documentation for the sidecar language. */
  sidecarSlots: string;
  /** Code-fence language tag for the client (e.g. "typescript"). */
  clientFenceTag: string;
  /** Code-fence language tag for the sidecar (e.g. "python"). */
  sidecarFenceTag: string;
}

/** Read both primary templates for a language pair and return them with slot docs. */
export function getTemplatesForPair(
  repoRoot: string,
  languagePair: string,
): TemplatesResult {
  const def = getPairDef(languagePair);

  const clientTemplate = readFileSync(
    path.join(repoRoot, "bridges", languagePair, def.clientTemplate),
    "utf8",
  );
  const sidecarTemplate = readFileSync(
    path.join(repoRoot, "bridges", languagePair, def.sidecarTemplate),
    "utf8",
  );

  return {
    clientTemplate,
    sidecarTemplate,
    clientSlots: def.clientSlots,
    sidecarSlots: def.sidecarSlots,
    clientFenceTag: FENCE_TAG[def.clientLang],
    sidecarFenceTag: FENCE_TAG[def.sidecarLang],
  };
}
