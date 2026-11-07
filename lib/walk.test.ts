import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkDirectory } from "./walk.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "files-editor-walk-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, ".github"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "hi");
  await writeFile(path.join(root, ".gitignore"), "dist");
  await writeFile(path.join(root, "src", "index.ts"), "export {}");
  await writeFile(path.join(root, "src", "nested", "deep.ts"), "export {}");
  await writeFile(path.join(root, ".github", "ci.yml"), "on: push");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const walk = (overrides: Partial<Parameters<typeof walkDirectory>[0]> = {}) =>
  walkDirectory({
    root,
    excludedNames: new Set(["node_modules"]),
    includeHidden: true,
    limit: 1000,
    ...overrides,
  });

describe("walkDirectory", () => {
  it("lists dotfiles and dot-directories, which BB's own listing drops", async () => {
    const { entries } = await walk();
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain(".gitignore");
    expect(paths).toContain(".github");
    expect(paths).toContain(".github/ci.yml");
  });

  it("omits them when hidden files are turned off", async () => {
    const { entries } = await walk({ includeHidden: false });
    expect(entries.map((entry) => entry.path)).not.toContain(".gitignore");
  });

  it("never descends into an excluded directory", async () => {
    const { entries } = await walk();
    expect(
      entries.filter((entry) => entry.path.startsWith("node_modules")),
    ).toEqual([]);
  });

  it("marks directories and reports paths relative to the root", async () => {
    const { entries } = await walk();
    expect(entries).toContainEqual({ path: "src", kind: "directory" });
    expect(entries).toContainEqual({ path: "src/nested/deep.ts", kind: "file" });
  });

  it("skips symlinks rather than following them into a cycle", async () => {
    await symlink(root, path.join(root, "loop"), "dir");
    const { entries } = await walk();
    expect(entries.map((entry) => entry.path)).not.toContain("loop");
  });

  it("keeps the shallow tree when it hits the entry cap", async () => {
    const { entries, truncated } = await walk({ limit: 3 });
    expect(truncated).toBe(true);
    expect(entries).toHaveLength(3);
    // Breadth-first: everything returned is still top level.
    expect(entries.every((entry) => !entry.path.includes("/"))).toBe(true);
  });

  it("throws for a missing root instead of reporting an empty workspace", async () => {
    await expect(walk({ root: path.join(root, "gone") })).rejects.toThrow();
  });
});
