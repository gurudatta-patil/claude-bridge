#!/usr/bin/env node
/**
 * index.ts — Ghost-Bridge MCP server entry point.
 *
 * Registers a single tool: `generate_ghost_bridge`
 * Transport: stdio (for `claude mcp add ghost-bridge -- npx ghost-bridge-mcp`)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleGenerateGhostBridge } from "./tool.js";
import { ALL_PAIRS } from "./language-pair.js";

const server = new McpServer({
  name: "ghost-bridge",
  version: "0.2.0",
});

server.tool(
  "generate_ghost_bridge",
  "Generate a Ghost-Bridge language-pair bridge for a named capability. " +
    "Supports all 13 pairs: typescript-python, typescript-ruby, typescript-rust, " +
    "typescript-go, go-python, go-ruby, go-nodejs, python-go, python-ruby, " +
    "python-rust, rust-go, rust-python, rust-ruby. " +
    "Creates .ghost-bridge/bridges/<bridge_name>.{ext}, copies shared helpers, " +
    "sets up the sidecar runtime, and updates .gitignore.",
  {
    bridge_name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_-]*$/, "Must be lowercase, start with a letter, no spaces")
      .describe("Identifier for this bridge, e.g. 'image_resize'"),
    target_capability: z
      .string()
      .min(10)
      .describe(
        "Plain-English description of what the bridge should do, e.g. " +
          "'resize and compress images using Pillow, returning base64-encoded JPEG'",
      ),
    dependencies: z
      .array(z.string())
      .describe(
        "Packages to install in the sidecar runtime. " +
          "Python: pip packages. Ruby: gems. Go/Rust: leave empty (use go.mod / Cargo.toml deps instead).",
      ),
    language_pair: z
      .enum(ALL_PAIRS as [string, ...string[]])
      .default("typescript-python")
      .describe(
        "Which language pair to generate. Format: <client_lang>-<sidecar_lang>, " +
          "e.g. 'typescript-python' (default), 'go-python', 'typescript-rust'.",
      ),
    project_root: z
      .string()
      .optional()
      .describe("Absolute path to the project root. Defaults to the server's cwd."),
  },
  async (params) => {
    try {
      const result = await handleGenerateGhostBridge(params);
      const pair = params.language_pair ?? "typescript-python";
      const [clientLang] = pair.split("-");
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
              ``,
              `Usage (${clientLang}):`,
              `  import { GhostBridge } from '.ghost-bridge/bridges/${params.bridge_name}';`,
              `  const bridge = new GhostBridge();`,
              `  await bridge.start();`,
              `  const result = await bridge.<method>(/* params */);`,
              `  await bridge.stop();`,
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
