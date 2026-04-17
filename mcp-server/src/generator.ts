/**
 * generator.ts — invoke Claude Code CLI to fill Ghost-Bridge template slots.
 *
 * Uses `claude --print "<prompt>"` (non-interactive print mode) rather than
 * the Anthropic SDK so no API key management is required — the user's existing
 * Claude Code session credentials are reused automatically.
 */

import { execFile as _execFile } from "child_process";
import { readFileSync } from "fs";
import * as path from "path";
import { promisify } from "util";
import { validateCode } from "./validator.js";
import { getPairDef, FENCE_TAG, type PairDef } from "./language-pair.js";

const execFile = promisify(_execFile);

export interface GenerateParams {
  bridgeName: string;
  targetCapability: string;
  dependencies: string[];
  /** Which language pair to generate, e.g. "typescript-python". */
  languagePair: string;
  /** Root of the ghost-bridge repo (to read templates). */
  repoRoot: string;
  /** Print Claude's raw response to stderr for debugging. */
  verbose?: boolean;
}

export interface GenerateResult {
  /** Generated client-side source code. */
  client: string;
  /** Generated sidecar source code (primary file). */
  sidecar: string;
  /** Raw response from Claude (for debugging). */
  rawResponse: string;
}

/** Read the file at `rel` relative to `repoRoot`, return its contents. */
function readTemplate(repoRoot: string, pair: string, rel: string): string {
  return readFileSync(path.join(repoRoot, "bridges", pair, rel), "utf8");
}

/** Extract a fenced code block's content from a markdown string. */
function extractBlock(text: string, lang: string): string | null {
  const re = new RegExp("```" + lang + "\\s*\\n([\\s\\S]+?)\\n```", "i");
  const m = re.exec(text);
  return m ? m[1].trimEnd() : null;
}

/** Build prompt for a specific language pair. */
function buildPrompt(
  params: GenerateParams,
  def: PairDef,
  clientTemplate: string,
  sidecarTemplate: string,
  extraConstraints?: string,
): string {
  const deps =
    params.dependencies.length > 0
      ? params.dependencies.join(", ")
      : "none — use stdlib only";

  const clientFence = FENCE_TAG[def.clientLang];
  const sidecarFence = FENCE_TAG[def.sidecarLang];

  const lines = [
    `You are generating files for Ghost-Bridge, an IPC bridge toolkit.`,
    `Your job: fill in the marked slots in the two templates below, then output`,
    `ONLY the completed files as two fenced code blocks (no prose, no explanation).`,
    ``,
    `═══ CLIENT SLOTS (${def.clientLang.toUpperCase()}) ═══`,
    ``,
    def.clientSlots,
    ``,
    `═══ SIDECAR SLOTS (${def.sidecarLang.toUpperCase()}) ═══`,
    ``,
    def.sidecarSlots,
    ``,
    `═══ REQUEST ═══`,
    ``,
    `Bridge name        : ${params.bridgeName}`,
    `Target capability  : ${params.targetCapability}`,
    `Sidecar packages   : ${deps}`,
    ``,
    `═══ ${def.clientLang.toUpperCase()} CLIENT TEMPLATE ═══`,
    ``,
    "```" + clientFence,
    clientTemplate,
    "```",
    ``,
    `═══ ${def.sidecarLang.toUpperCase()} SIDECAR TEMPLATE ═══`,
    ``,
    "```" + sidecarFence,
    sidecarTemplate,
    "```",
    ``,
    `Now output the completed files. Start immediately with \`\`\`${clientFence}, no preamble.`,
  ];

  if (extraConstraints) {
    lines.push(``, `Additional constraints (previous attempt failed):`, extraConstraints);
  }

  return lines.join("\n");
}

function extractResult(
  raw: string,
  def: PairDef,
): Omit<GenerateResult, "rawResponse"> {
  const clientFence = FENCE_TAG[def.clientLang];
  const sidecarFence = FENCE_TAG[def.sidecarLang];

  const client = extractBlock(raw, clientFence);
  const sidecar = extractBlock(raw, sidecarFence);

  if (!client)
    throw new Error(
      `Claude output did not contain a \`\`\`${clientFence} block.\nFull output:\n${raw}`,
    );
  if (!sidecar)
    throw new Error(
      `Claude output did not contain a \`\`\`${sidecarFence} block.\nFull output:\n${raw}`,
    );

  return { client, sidecar };
}

/**
 * Call Claude Code CLI and return generated client + sidecar code.
 * Retries once if validation fails.
 */
export async function generateBridge(
  params: GenerateParams,
): Promise<GenerateResult> {
  const def = getPairDef(params.languagePair);

  const clientTemplate = readTemplate(
    params.repoRoot,
    params.languagePair,
    def.clientTemplate,
  );
  const sidecarTemplate = readTemplate(
    params.repoRoot,
    params.languagePair,
    def.sidecarTemplate,
  );

  const prompt = buildPrompt(params, def, clientTemplate, sidecarTemplate);
  const raw = await runClaude(prompt);

  if (params.verbose) {
    process.stderr.write(
      "\n─── Claude raw response ───\n" + raw + "\n───────────────────────────\n",
    );
  }

  const result = extractResult(raw, def);

  // Validate — collect all failures across both files.
  const clientCheck = validateCode(result.client, def.clientLang);
  const sidecarCheck = validateCode(result.sidecar, def.sidecarLang);

  if (clientCheck.ok && sidecarCheck.ok) return { ...result, rawResponse: raw };

  // Retry once with stricter instructions.
  const failures = [...clientCheck.failures, ...sidecarCheck.failures];
  const retryPrompt = buildPrompt(
    params,
    def,
    clientTemplate,
    sidecarTemplate,
    failures.map((f) => `  - ${f}`).join("\n"),
  );

  const raw2 = await runClaude(retryPrompt);

  if (params.verbose) {
    process.stderr.write(
      "\n─── Claude retry response ───\n" + raw2 + "\n─────────────────────────────\n",
    );
  }

  return { ...extractResult(raw2, def), rawResponse: raw2 };
}

/** Spawn `claude --print "<prompt>"` and return stdout. */
export async function runClaude(prompt: string): Promise<string> {
  const { stdout } = await execFile("claude", ["--print", prompt], {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}
