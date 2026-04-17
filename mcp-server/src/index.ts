#!/usr/bin/env node
/**
 * index.ts — Stitch MCP server (scaffold-only design).
 *
 * Two tools:
 *
 *   1. get_stitch_templates(language_pair)
 *      Returns raw template files + slot documentation.
 *      Claude Code reads this, fills in the slots in its own context.
 *
 *   2. setup_stitch(bridge_name, language_pair, client_code, sidecar_code, ...)
 *      Receives the filled-in code from Claude, then does all the deterministic
 *      work: write files, patch import paths, copy shared helpers, set up
 *      venv / go build / cargo build, update .gitignore.
 *
 * No subprocess is spawned for code generation — Claude Code IS the generator.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleGetTemplates, handleSetupStitch } from "./tool.js";
import { ALL_PAIRS } from "./language-pair.js";

const server = new McpServer({
  name: "stitch",
  version: "0.3.0",
});

// ── Tool 1: get_stitch_templates ────────────────────────────────────────

server.tool(
  "get_stitch_templates",
  "Step 1 of 2. Returns the raw template files and slot-filling documentation " +
    "for the requested language pair. After calling this tool, fill in the slots " +
    "yourself using the capability the user described, then call setup_stitch " +
    "with the completed code. Do NOT call claude --print or spawn any subprocess — " +
    "you are the code generator.",
  {
    language_pair: z
      .enum(ALL_PAIRS as [string, ...string[]])
      .default("typescript-python")
      .describe(
        "Which language pair to generate. Format: <client_lang>-<sidecar_lang>. " +
          "E.g. 'typescript-python' (default), 'typescript-rust', 'go-python'.",
      ),
  },
  async (params) => {
    try {
      const result = await handleGetTemplates(params);
      return {
        content: [
          {
            type: "text",
            text: [
              `Language pair  : ${params.language_pair}`,
              `Client lang    : ${result.clientFenceTag}`,
              `Sidecar lang   : ${result.sidecarFenceTag}`,
              ``,
              `══ CLIENT SLOT DOCUMENTATION ══`,
              result.clientSlots,
              ``,
              `══ SIDECAR SLOT DOCUMENTATION ══`,
              result.sidecarSlots,
              ``,
              `══ CLIENT TEMPLATE (${result.clientFenceTag}) ══`,
              "```" + result.clientFenceTag,
              result.clientTemplate,
              "```",
              ``,
              `══ SIDECAR TEMPLATE (${result.sidecarFenceTag}) ══`,
              "```" + result.sidecarFenceTag,
              result.sidecarTemplate,
              "```",
              ``,
              `Now fill in the slots above for the requested capability, then call setup_stitch.`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ── Tool 2: setup_stitch ────────────────────────────────────────────────

server.tool(
  "setup_stitch",
  "Step 2 of 2. Receives the filled-in bridge code and does all deterministic " +
    "scaffolding: writes files to .stitch/bridges/, patches import paths, " +
    "copies shared helpers into .stitch/shared/, sets up the sidecar runtime " +
    "(Python venv + pip, Ruby gems, go build, cargo build --release), and updates .gitignore. " +
    "Call this after you have filled in the templates returned by get_stitch_templates.",
  {
    bridge_name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_-]*$/, "Must be lowercase, start with a letter, no spaces")
      .describe("Identifier for this bridge, e.g. 'image_resize'"),
    language_pair: z
      .enum(ALL_PAIRS as [string, ...string[]])
      .default("typescript-python")
      .describe("Same language_pair you passed to get_stitch_templates."),
    client_code: z
      .string()
      .min(1)
      .describe(
        "Fully filled-in client source code (TypeScript, Python, Go, or Rust). " +
          "Must not contain unfilled slot markers.",
      ),
    sidecar_code: z
      .string()
      .min(1)
      .describe(
        "Fully filled-in sidecar source code (Python, Ruby, Go, Rust, or Node.js). " +
          "Must not contain unfilled slot markers.",
      ),
    dependencies: z
      .array(z.string())
      .describe(
        "Packages to install in the sidecar runtime. " +
          "Python: pip packages. Ruby: gems. Go/Rust: leave empty.",
      ),
    project_root: z
      .string()
      .optional()
      .describe("Absolute path to the project root. Defaults to the server's cwd."),
  },
  async (params) => {
    try {
      const result = await handleSetupStitch(params);
      const [clientLang] = (params.language_pair ?? "typescript-python").split("-");
      return {
        content: [
          {
            type: "text",
            text: [
              result.message,
              ``,
              `Client (${clientLang})  : ${result.client_path}`,
              `Sidecar           : ${result.sidecar_path}`,
              `Runtime           : ${result.runtime_info}`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
