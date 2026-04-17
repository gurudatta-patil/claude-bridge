import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { ensureGitignore, removeGitignoreBlock } from "../../src/gitignore.js";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `stitch-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ensureGitignore", () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("creates .gitignore when none exists", () => {
    ensureGitignore(dir);
    const gi = path.join(dir, ".gitignore");
    expect(existsSync(gi)).toBe(true);
    const content = readFileSync(gi, "utf8");
    expect(content).toContain(".stitch/");
    expect(content).toContain("# stitch-start");
    expect(content).toContain("# stitch-end");
  });

  test("appends to existing .gitignore without corrupting it", () => {
    const gi = path.join(dir, ".gitignore");
    writeFileSync(gi, "node_modules/\ndist/\n", "utf8");

    ensureGitignore(dir);

    const content = readFileSync(gi, "utf8");
    expect(content).toContain("node_modules/");
    expect(content).toContain("dist/");
    expect(content).toContain(".stitch/");
  });

  test("is idempotent — calling twice does not duplicate entries", () => {
    ensureGitignore(dir);
    ensureGitignore(dir);

    const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
    const startCount = (content.match(/# stitch-start/g) ?? []).length;
    expect(startCount).toBe(1);
  });

  test("removeGitignoreBlock removes the managed block", () => {
    ensureGitignore(dir);
    removeGitignoreBlock(dir);

    const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(content).not.toContain("# stitch-start");
    expect(content).not.toContain(".stitch/");
  });

  test("removeGitignoreBlock preserves pre-existing content", () => {
    const gi = path.join(dir, ".gitignore");
    writeFileSync(gi, "node_modules/\n", "utf8");
    ensureGitignore(dir);
    removeGitignoreBlock(dir);

    const content = readFileSync(gi, "utf8");
    expect(content).toContain("node_modules/");
  });

  test("removeGitignoreBlock is a no-op when file does not exist", () => {
    expect(() => removeGitignoreBlock(dir)).not.toThrow();
  });
});
