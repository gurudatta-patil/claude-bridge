/**
 * validator.ts — post-generation sanity checks for Ghost-Bridge output.
 *
 * Rules check only what appears in the GENERATED portion of each template.
 * Shared base classes (sidecar_base.py, BridgeClientBase, etc.) handle the
 * RPC machinery — we don't validate those here.
 */

// lang values match ClientLang | SidecarLang from language-pair.ts; using string avoids circular import.

export interface ValidationResult {
  ok: boolean;
  failures: string[];
}

// ── Python sidecar ────────────────────────────────────────────────────────────

export function validatePython(code: string): ValidationResult {
  const failures: string[] = [];

  if (!code.includes("_rpc_out = _sys.stdout"))
    failures.push("Missing stdout discipline: `_rpc_out = _sys.stdout`");

  if (!code.includes("_sys.stdout = _sys.stderr"))
    failures.push("Missing stdout redirect: `_sys.stdout = _sys.stderr`");

  if (/(?<![_\w])print\s*\(/.test(code))
    failures.push("Contains bare `print(` — all output must go via _rpc_out");

  if (/sys\.stdout\.write/.test(code))
    failures.push("Contains `sys.stdout.write` — use `_rpc_out.write` instead");

  if (code.includes("# GHOST-BRIDGE-WARNING"))
    failures.push("Contains GHOST-BRIDGE-WARNING — dependency requires a C++ compiler");

  return { ok: failures.length === 0, failures };
}

// ── TypeScript client ─────────────────────────────────────────────────────────

export function validateTypeScript(code: string): ValidationResult {
  const failures: string[] = [];

  const hasClass =
    /class\s+\w+\s+(extends\s+BridgeClientBase|{)/.test(code) ||
    code.includes("class GhostBridge") ||
    code.includes("class PythonBridge") ||
    code.includes("class RubyBridge") ||
    code.includes("class RustBridge") ||
    code.includes("class GoBridge");
  if (!hasClass)
    failures.push("Missing bridge class extending BridgeClientBase");

  if (!code.includes("killChild("))
    failures.push("Missing `killChild(` — destroy() must call killChild");

  return { ok: failures.length === 0, failures };
}

// ── Ruby sidecar ──────────────────────────────────────────────────────────────

export function validateRuby(code: string): ValidationResult {
  const failures: string[] = [];

  if (!code.includes("run_sidecar("))
    failures.push("Missing `run_sidecar(` entry-point call");

  if (!code.includes("require_relative"))
    failures.push("Missing `require_relative` for sidecar_base");

  if (/\bputs\b/.test(code))
    failures.push("Contains `puts` — sidecar_base handles all output; never use puts");

  return { ok: failures.length === 0, failures };
}

// ── Go sidecar ────────────────────────────────────────────────────────────────

export function validateGo(code: string): ValidationResult {
  const failures: string[] = [];

  if (!code.includes("sidecar.SendReady("))
    failures.push("Missing `sidecar.SendReady(` — required for handshake");

  if (!code.includes("sidecar.NewScanner("))
    failures.push("Missing `sidecar.NewScanner(` — required for stdin loop");

  if (!code.includes("sidecar.SendResponse("))
    failures.push("Missing `sidecar.SendResponse(` — required to respond to requests");

  if (!code.includes("sidecar.InstallSignalHandler("))
    failures.push("Missing `sidecar.InstallSignalHandler(` — required for clean shutdown");

  return { ok: failures.length === 0, failures };
}

// ── Rust sidecar ──────────────────────────────────────────────────────────────

export function validateRust(code: string): ValidationResult {
  const failures: string[] = [];

  if (!code.includes("run_sidecar("))
    failures.push("Missing `run_sidecar(` — entry point required");

  if (!code.includes("serde_json") && !code.includes("serde_json::"))
    failures.push("Missing serde_json usage — params must be deserialised");

  return { ok: failures.length === 0, failures };
}

// ── JavaScript / Node.js sidecar ──────────────────────────────────────────────

export function validateNodeJs(code: string): ValidationResult {
  const failures: string[] = [];

  if (!code.includes('{ ready: true }') && !code.includes('"ready":true') && !code.includes('"ready": true'))
    failures.push("Missing ready signal: `process.stdout.write(JSON.stringify({ ready: true }) + '\\n')`");

  if (!code.includes("readline"))
    failures.push("Missing `readline` — required for stdin line-by-line reading");

  if (/\bconsole\.log\b/.test(code))
    failures.push("Contains `console.log` — all output must go through process.stdout.write");

  return { ok: failures.length === 0, failures };
}

// ── Python client ─────────────────────────────────────────────────────────────

export function validatePythonClient(code: string): ValidationResult {
  const failures: string[] = [];

  if (!code.includes("BridgeClientBase") && !code.includes("GoBridge") && !code.includes("RubyBridge") && !code.includes("RustBridge"))
    failures.push("Missing BridgeClientBase (or named subclass) — client must inherit from it");

  return { ok: failures.length === 0, failures };
}

// ── Go client ─────────────────────────────────────────────────────────────────

export function validateGoClient(code: string): ValidationResult {
  const failures: string[] = [];

  if (!code.includes("WaitReady") && !code.includes("ghostbridge.WaitReady"))
    failures.push("Missing WaitReady call — required to wait for sidecar handshake");

  if (!code.includes("PendingMap") && !code.includes("pending"))
    failures.push("Missing PendingMap — required for async request tracking");

  return { ok: failures.length === 0, failures };
}

// ── Rust client ───────────────────────────────────────────────────────────────

export function validateRustClient(code: string): ValidationResult {
  const failures: string[] = [];

  if (!code.includes("PendingMap") && !code.includes("pending_map"))
    failures.push("Missing PendingMap — required for async request tracking");

  if (!code.includes("kill_child"))
    failures.push("Missing `kill_child` — Drop impl must call kill_child");

  return { ok: failures.length === 0, failures };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Validate generated code for the given language role.
 * `lang` is a ClientLang or SidecarLang value.
 */
export function validateCode(
  code: string,
  lang: string,
): ValidationResult {
  switch (lang) {
    // Sidecar languages
    case "python":   return validatePython(code);
    case "ruby":     return validateRuby(code);
    case "nodejs":   return validateNodeJs(code);
    case "go":       return validateGo(code);
    case "rust":     return validateRust(code);
    // Client languages — TypeScript is the same as the sidecar ts validator isn't needed
    case "typescript": return validateTypeScript(code);
    default:         return { ok: true, failures: [] };
  }
}
