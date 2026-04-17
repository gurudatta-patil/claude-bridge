import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { validatePython, validateTypeScript } from "../../src/validator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../fixtures");

const validPy = readFileSync(path.join(FIXTURES, "valid-python.py"), "utf8");
const validTs = readFileSync(path.join(FIXTURES, "valid-typescript.ts"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// Python validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validatePython", () => {
  test("fixture passes all checks", () => {
    const r = validatePython(validPy);
    expect(r.ok).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  test("missing _rpc_out = _sys.stdout", () => {
    const bad = validPy.replace("_rpc_out = _sys.stdout", "# removed");
    const r = validatePython(bad);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("_rpc_out = _sys.stdout"))).toBe(true);
  });

  test("missing _sys.stdout = _sys.stderr redirect", () => {
    const bad = validPy.replace("_sys.stdout = _sys.stderr", "# removed");
    const r = validatePython(bad);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("_sys.stdout = _sys.stderr"))).toBe(true);
  });

  test("bare print() detected", () => {
    const bad = validPy + '\nprint("oops")\n';
    const r = validatePython(bad);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("print("))).toBe(true);
  });

  test("sys.stdout.write detected", () => {
    const bad = validPy + '\nsys.stdout.write("oops")\n';
    const r = validatePython(bad);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("sys.stdout.write"))).toBe(true);
  });

  test("STITCH-WARNING detected", () => {
    const bad = validPy + "\n# STITCH-WARNING: some-pkg requires a C++ compiler.\n";
    const r = validatePython(bad);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("STITCH-WARNING"))).toBe(true);
  });

  test("multiple failures are all reported", () => {
    const bad = validPy
      .replace("_rpc_out = _sys.stdout", "# removed")
      .replace("_sys.stdout = _sys.stderr", "# removed");
    const r = validatePython(bad);
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TypeScript validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateTypeScript", () => {
  test("fixture passes all checks", () => {
    const r = validateTypeScript(validTs);
    expect(r.ok).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  test("missing bridge class declaration", () => {
    // Remove the class declaration entirely — not just rename it
    const bad = validTs.replace(/export class \w+[^{]*\{/, "// class removed\nconst _noop = {");
    const r = validateTypeScript(bad);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("class"))).toBe(true);
  });

  test("missing killChild(", () => {
    const bad = validTs.replace(/killChild\(/g, "terminate(");
    const r = validateTypeScript(bad);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("killChild("))).toBe(true);
  });
});
