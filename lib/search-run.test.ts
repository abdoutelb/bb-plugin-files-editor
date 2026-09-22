import { describe, expect, it } from "vitest";
import {
  createInProcessExecutor,
  createWorkerExecutor,
  PatternTooSlowError,
} from "./regex-worker.js";
import { runSearch, type SearchSource } from "./search-run.js";
import type { SearchQuery } from "./text-search.js";

const q = (query: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({
  query,
  matchCase: false,
  wholeWord: false,
  regex: false,
  ...extra,
});

function mapSource(files: Record<string, string | null>, truncated = false): SearchSource {
  return {
    concurrency: 2,
    async list() {
      return { paths: Object.keys(files).sort(), truncated };
    },
    async read(path) {
      return files[path] ?? null;
    },
  };
}

const LIMITS = { maxMatches: 1000, maxFiles: 100, timeBudgetMs: 10_000 };

const run = (
  source: SearchSource,
  query: SearchQuery,
  overrides: Partial<Parameters<typeof runSearch>[0]> = {},
) =>
  runSearch({
    source,
    query,
    limits: LIMITS,
    signal: new AbortController().signal,
    now: () => 0,
    createExecutor: (pattern, flags) => createInProcessExecutor(pattern, flags),
    ...overrides,
  });

describe("runSearch", () => {
  it("finds text across files and reports them in path order", async () => {
    const outcome = await run(
      mapSource({
        "src/b.ts": "const token = 1;\nuse(token);",
        "src/a.ts": "no match here",
        "README.md": "token docs",
      }),
      q("token"),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.files.map((file) => file.path)).toEqual(["README.md", "src/b.ts"]);
    expect(outcome.totalMatches).toBe(3);
    expect(outcome.searchedFiles).toBe(3);
    expect(outcome.truncated).toBe(false);
    expect(outcome.files[1]!.matches.map((match) => match.line)).toEqual([1, 2]);
  });

  it("skips files the source declines to read", async () => {
    const outcome = await run(mapSource({ "a.bin": null, "b.txt": "needle" }), q("needle"));
    if (outcome.status !== "ok") throw new Error(outcome.status);
    expect(outcome.searchedFiles).toBe(1);
    expect(outcome.files.map((file) => file.path)).toEqual(["b.txt"]);
  });

  it("stops at the match cap and says why", async () => {
    const outcome = await runSearch({
      source: mapSource({ "a.txt": "x x x", "b.txt": "x x x", "c.txt": "x x x" }),
      query: q("x"),
      limits: { ...LIMITS, maxMatches: 4 },
      signal: new AbortController().signal,
      now: () => 0,
      createExecutor: (pattern, flags) => createInProcessExecutor(pattern, flags),
    });
    if (outcome.status !== "ok") throw new Error(outcome.status);
    expect(outcome.totalMatches).toBe(4);
    expect(outcome.truncated).toBe(true);
    expect(outcome.reason).toBe("matches");
  });

  it("stops at the file cap", async () => {
    const outcome = await runSearch({
      source: mapSource({ "a.txt": "x", "b.txt": "x", "c.txt": "x" }),
      query: q("x"),
      limits: { ...LIMITS, maxFiles: 2 },
      signal: new AbortController().signal,
      now: () => 0,
      createExecutor: (pattern, flags) => createInProcessExecutor(pattern, flags),
    });
    if (outcome.status !== "ok") throw new Error(outcome.status);
    expect(outcome.files).toHaveLength(2);
    expect(outcome.reason).toBe("files");
  });

  it("stops when the time budget runs out", async () => {
    let clock = 0;
    const outcome = await runSearch({
      source: mapSource({ "a.txt": "x", "b.txt": "x", "c.txt": "x", "d.txt": "x" }),
      query: q("x"),
      limits: { ...LIMITS, timeBudgetMs: 5 },
      signal: new AbortController().signal,
      now: () => (clock += 4),
      createExecutor: (pattern, flags) => createInProcessExecutor(pattern, flags),
    });
    if (outcome.status !== "ok") throw new Error(outcome.status);
    expect(outcome.reason).toBe("time");
    expect(outcome.truncated).toBe(true);
  });

  it("passes on a listing that was itself truncated", async () => {
    const outcome = await run(mapSource({ "a.txt": "x" }, true), q("x"));
    if (outcome.status !== "ok") throw new Error(outcome.status);
    expect(outcome.truncated).toBe(true);
    expect(outcome.reason).toBe("listing");
  });

  it("gives up as soon as a newer search aborts it", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await run(mapSource({ "a.txt": "x" }), q("x"), { signal: controller.signal })).status).toBe(
      "cancelled",
    );
  });

  it("reports an invalid regex as an error, not a crash", async () => {
    const outcome = await run(mapSource({ "a.txt": "x" }), q("(", { regex: true }));
    expect(outcome.status).toBe("error");
  });

  it("disposes the executor whatever happens", async () => {
    let disposed = 0;
    await run(mapSource({ "a.txt": "x" }), q("x"), {
      createExecutor: (pattern, flags) => {
        const inner = createInProcessExecutor(pattern, flags);
        return { exec: inner.exec, dispose: () => (disposed += 1) };
      },
    });
    expect(disposed).toBe(1);
  });
});

describe("the in-process executor", () => {
  it("shares one match budget across a batch", async () => {
    const executor = createInProcessExecutor("a", "g");
    const out = await executor.exec(["aaa", "aaa"], 4);
    expect(out.map((hits) => hits.length)).toEqual([3, 1]);
  });
});

describe("the worker executor", () => {
  it("runs a regex off the main thread", async () => {
    const executor = createWorkerExecutor("id=(\\d+)", "g");
    try {
      const out = await executor.exec(["id=1 id=22", "none"], 10);
      expect(out).toEqual([[[0, 4], [5, 5]], []]);
    } finally {
      executor.dispose();
    }
  });

  it("kills a catastrophically backtracking pattern instead of hanging", async () => {
    // (a+)+$ against a run of a's that ends in a mismatch is exponential. On
    // the server's own thread this would freeze all of BB.
    const executor = createWorkerExecutor("(a+)+$", "g", 300);
    const started = Date.now();
    await expect(executor.exec([`${"a".repeat(40)}!`], 10)).rejects.toBeInstanceOf(
      PatternTooSlowError,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    executor.dispose();
  });

  it("turns a too-slow pattern into a readable search error", async () => {
    const outcome = await runSearch({
      source: mapSource({ "a.txt": `${"a".repeat(40)}!` }),
      query: q("(a+)+$", { regex: true }),
      limits: LIMITS,
      signal: new AbortController().signal,
      now: () => 0,
      createExecutor: (pattern, flags) => createWorkerExecutor(pattern, flags, 300),
    });
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") expect(outcome.message).toMatch(/too slow/);
  });
});
