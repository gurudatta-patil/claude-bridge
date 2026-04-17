# Stitch

**Import anything. From anywhere.**

Every language has something the others don't. Python has the ML ecosystem. Go has concurrency and speed. Rust has zero-cost safety. Ruby has expressive elegance. But your project is in TypeScript — or Go — or Python — and rewriting it isn't the answer.

Stitch lets you call functions across language boundaries as if they were local imports. You describe the function you need, Claude Code generates a typed bridge, and Stitch spins up a lightweight child process for that capability — and only that capability. Your main app stays in its language. The other language runs only the functions that need it.

```typescript
// TypeScript app — using Python's ML ecosystem
const { faces } = await bridge.detect({ image_b64 });

// TypeScript app — using Go's native PDF renderer
const { pdf_b64 } = await bridge.render({ html, pageSize: "A4" });
```

```python
# Python app — using Rust for CPU-intensive number crunching
result = bridge.call("compute_fft", {"signal": data})
```

No HTTP server. No Docker. No ports. No lingering processes. Just a function call that happens to run in a different language — and disappears cleanly when your app exits.

> Built for **Claude Code**. Stitch is an MCP server — describe what you need and Claude generates the bridge for you.

---

## MCP Server (recommended)

Stitch ships as a Claude Code MCP server with two tools:

| Tool | What it does |
|------|-------------|
| `get_stitch_templates` | Returns the raw template + slot docs for a language pair |
| `setup_stitch` | Writes files, patches paths, copies shared helpers, sets up venv/build |

**Claude Code is the code generator.** The MCP handles only the deterministic scaffolding work — no subprocess is spawned, no second LLM call is made.

### 1. Register once

```bash
claude mcp add stitch -- npx tsx /path/to/stitch/mcp-server/src/index.ts
```

Verify:

```bash
claude mcp list
```

### 2. Open Claude Code in your project

```bash
cd your-project
claude
```

### 3. Describe what you need

```
Create a Stitch for me:

  bridge_name: image_processor
  language_pair: typescript-python
  dependencies: ["Pillow"]
  capability: >
    Method: resize({ image_b64, width, height })
    - decode base64 JPEG → PIL Image
    - resize with LANCZOS
    - re-encode at 85% quality
    - return { image_b64 }

Call get_stitch_templates, fill in the slots, then call setup_stitch.
```

Claude Code will call `get_stitch_templates`, fill in the implementation in its own context, then call `setup_stitch` to scaffold everything.

### 4. Use the bridge

```typescript
import { PythonBridge } from "./.stitch/bridges/image_processor.js";

const bridge = new PythonBridge("./path/to/image_processor.py");
await bridge.start();
const result = await bridge.resize({ image_b64: rawB64, width: 800, height: 600 });
await bridge.stop();
```

---

## Supported language pairs

| Client \ Sidecar | Python | Ruby | Go | Rust | Node.js |
|-----------------|:------:|:----:|:--:|:----:|:-------:|
| **TypeScript**  |   ✅   |  ✅  | ✅ |  ✅  |    —    |
| **Go**          |   ✅   |  ✅  |  — |   —  |   ✅    |
| **Python**      |    —   |  ✅  | ✅ |  ✅  |    —    |
| **Rust**        |   ✅   |  ✅  | ✅ |   —  |    —    |

Specify `language_pair` as `<client>-<sidecar>`, e.g. `typescript-python`, `go-ruby`, `rust-go`.

---

## What gets generated

```
.stitch/
  bridges/
    image_processor.ts    ← TypeScript client class
    image_processor.py    ← Python sidecar
    .venv/                ← isolated Python venv  (gitignored)
  shared/
    bridge-client-base.ts
    path-helpers.ts
    sidecar_base.py
```

For compiled sidecars (Go, Rust), the sidecar source lives in `bridges/<name>_sidecar/` and is built to a binary automatically.

---

## How it works

You get two generated files per bridge — a typed client in your language, and a sidecar in the target language. When you call a method, the client spawns the sidecar as a child process on first use, sends it the request over stdin, and waits for the result on stdout. The sidecar exits automatically when your app exits — no cleanup code needed.

Each bridge is scoped to exactly the functions you asked for. You're not embedding a Python interpreter or linking a Go runtime into your app — you're spawning a small focused process that does one job.

---

## Prerequisites

| Sidecar | Requirement |
|---------|-------------|
| Python  | Python 3.9+; `uv` optional (faster venv creation) |
| Ruby    | Ruby 3.1+ |
| Go      | Go 1.21+ in PATH |
| Rust    | Rust stable via `rustup`; first build ~30 s |
| Node.js | Node 18+ in PATH |

---

> **Note:** `samples/` contains demonstration projects only. They are not part of Stitch itself and are not required for any project that uses the MCP.

---

## Slash command (alternative)

If you prefer not to use the MCP, a slash command is also available. Copy `.claude/commands/` from this repo into your project:

```bash
cp -r /path/to/stitch/.claude ./
```

Then in Claude Code:

```
/stitch typescript python image_processor 'resize images using Pillow' 'Pillow'
```
