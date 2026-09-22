import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalTextCache,
  MAX_SEARCH_FILE_BYTES,
  REMOTE_SEARCH_FILE_LIMIT,
  RemoteTextCache,
  createLocalSource,
  createRemoteSource,
} from "./search-sources.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "files-editor-search-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalTextCache", () => {
  it("reads a text file", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello");
    expect(await new LocalTextCache().get(path.join(dir, "a.txt"))).toBe("hello");
  });

  it("serves a file from memory inside the freshness window, without re-reading", async () => {
    let clock = 1_000;
    const cache = new LocalTextCache(undefined, () => clock);
    const file = path.join(dir, "a.txt");
    await writeFile(file, "first");
    expect(await cache.get(file)).toBe("first");

    await writeFile(file, "second");
    clock += 500;
    expect(await cache.get(file)).toBe("first");
  });

  it("notices a change once the window has passed", async () => {
    let clock = 1_000;
    const cache = new LocalTextCache(undefined, () => clock);
    const file = path.join(dir, "a.txt");
    await writeFile(file, "first");
    await cache.get(file);

    await writeFile(file, "second, and longer");
    // A different size is enough on its own; bump mtime too to be unambiguous.
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    clock += 10_000;
    expect(await cache.get(file)).toBe("second, and longer");
  });

  it("forgets a file on delete, so a save is searched as written", async () => {
    const cache = new LocalTextCache();
    const file = path.join(dir, "a.txt");
    await writeFile(file, "old");
    await cache.get(file);
    await writeFile(file, "new");
    cache.delete(file);
    expect(await cache.get(file)).toBe("new");
  });

  it("skips binary files and files over the size cap", async () => {
    const cache = new LocalTextCache();
    await writeFile(path.join(dir, "bin"), Buffer.from([1, 2, 0, 3]));
    await writeFile(path.join(dir, "big.txt"), "x".repeat(MAX_SEARCH_FILE_BYTES + 1));
    expect(await cache.get(path.join(dir, "bin"))).toBeNull();
    expect(await cache.get(path.join(dir, "big.txt"))).toBeNull();
  });

  it("returns null for a file that no longer exists", async () => {
    expect(await new LocalTextCache().get(path.join(dir, "missing.txt"))).toBeNull();
  });

  it("evicts the least recently used file past its byte budget", async () => {
    // Each 100-char file weighs ~264 bytes; a 600-byte budget holds two.
    const cache = new LocalTextCache(600);
    for (const name of ["a", "b", "c"]) {
      await writeFile(path.join(dir, name), name.repeat(100));
      await cache.get(path.join(dir, name));
    }
    expect(cache.size).toBe(2);
    expect(cache.sizeBytes).toBeLessThanOrEqual(600);
  });
});

describe("createLocalSource", () => {
  it("skips binary extensions without touching the disk", async () => {
    const source = createLocalSource({
      root: dir,
      list: async () => ({ paths: ["logo.png"], truncated: false }),
      cache: new LocalTextCache(),
    });
    expect(await source.read("logo.png")).toBeNull();
  });

  it("refuses to read outside the workspace", async () => {
    const source = createLocalSource({
      root: dir,
      list: async () => ({ paths: [], truncated: false }),
      cache: new LocalTextCache(),
    });
    await expect(source.read("../../etc/passwd")).rejects.toThrow(/escapes the workspace/);
  });
});

describe("createRemoteSource", () => {
  it("bounds how many files a remote search reads", async () => {
    const paths = Array.from({ length: REMOTE_SEARCH_FILE_LIMIT + 5 }, (_, i) => `f${i}.txt`);
    const source = createRemoteSource({
      root: "/srv/app",
      hostId: "host_1",
      list: async () => ({ paths, truncated: false }),
      readRemote: async () => ({ text: "" }),
      cache: new RemoteTextCache(),
    });
    const listed = await source.list();
    expect(listed.paths).toHaveLength(REMOTE_SEARCH_FILE_LIMIT);
    expect(listed.truncated).toBe(true);
  });

  it("reads each remote file once while it is fresh", async () => {
    let reads = 0;
    const source = createRemoteSource({
      root: "/srv/app",
      hostId: "host_1",
      list: async () => ({ paths: ["a.ts"], truncated: false }),
      readRemote: async () => {
        reads += 1;
        return { text: "remote" };
      },
      cache: new RemoteTextCache(),
    });
    expect(await source.read("a.ts")).toBe("remote");
    expect(await source.read("a.ts")).toBe("remote");
    expect(reads).toBe(1);
  });
});
