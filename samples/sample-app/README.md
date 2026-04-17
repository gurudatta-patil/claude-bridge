# Ghost-Bridge Sample — Text Analyser

A TypeScript app that calls a Python text-analysis library via Ghost-Bridge.

`analyze.py` already runs standalone in Python.  
The goal: call it from TypeScript without rewriting anything.

---

## Step 1 — verify the Python script works

```bash
python3 analyze.py data/sample.txt
```

Expected output:
```
Words          : 456
Sentences      : 28
Unique words   : 262
Readability    : 37.1 / 100
Top words      : consciousness, brain, why, experience, information
```

---

## Step 2 — register the MCP server (once, globally)

```bash
claude mcp add ghost-bridge -- npx tsx /Users/gurudattapatil/Documents/GitHub/claude-bridge/mcp-server/src/index.ts
```

Verify it's registered:

```bash
claude mcp list
```

---

## Step 3 — install deps

```bash
npm install
```

---

## Step 3 — open Claude Code in this folder

```bash
cd sample-app
claude
```

---

## Step 4 — paste this prompt into Claude Code

```
Use the generate_ghost_bridge MCP tool to create a bridge with these details:

  bridge_name: text_analyzer
  target_capability: >
    Expose three methods from the Python text-analysis logic in analyze.py:

    1. summarize(text: string) → returns an object with:
         word_count (int), sentence_count (int), unique_words (int),
         readability_score (float 0-100), top_words (list of [word, count] pairs)

    2. top_words(text: string, n: int) → returns { top_words: [[word, count], ...] }
         Returns the top N most frequent non-stopword words.

    3. readability(text: string) → returns { score: float }
         Flesch Reading Ease score (0-100, higher = easier to read).

    No extra pip packages needed — stdlib only (re, collections).

  dependencies: []

After generating the bridge, update analyze.ts to:
  - import TextAnalyzerBridge from .ghost-bridge/bridges/text_analyzer
  - remove the placeholder console.log
  - uncomment the bridge usage block
```

---

## Step 5 — run it

```bash
npm run analyze
```

Expected output:
```
══════════════════════════════════════════════════════
  Text Analysis Report
══════════════════════════════════════════════════════
  Words          : 456
  Sentences      : 28
  Unique words   : 262
  Readability    : 37.1 / 100
  Top words      : consciousness, brain, why, experience, information, ...
══════════════════════════════════════════════════════
```

---

## What Ghost-Bridge generates

```
.ghost-bridge/
  bridges/
    text_analyzer.py    ← Python sidecar (stdin/stdout JSON-RPC)
    text_analyzer.ts    ← TypeScript client class
  venvs/
    text_analyzer/      ← isolated Python venv (stdlib-only here)
```

The Python sidecar starts as a child process, communicates over stdin/stdout  
using newline-delimited JSON, and exits automatically when your TypeScript  
process exits.

---

## How it works under the hood

```
analyze.ts
  └─ new TextAnalyzerBridge()
       └─ spawn("python3", ["text_analyzer.py"])
            │  stdin  {"id":"x","method":"summarize","params":{"text":"..."}}
            │  stdout {"id":"x","result":{"word_count":428,...}}
            └─ child exits when parent's stdin pipe closes
```
