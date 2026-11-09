import { readFile, stat } from "node:fs/promises";
import { resolveWithinRoot } from "./paths.js";
import type { SearchSource } from "./search-run.js";
import { hasBinaryExtension, looksBinary } from "./text-search.js";

/** Nothing past this is worth reading for a text search: bundles, dumps, data. */
export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Within this long of the last check a cached file is trusted without a stat.
 * Typing a query sends a search every few hundred milliseconds; re-statting
 * thousands of files for each keystroke is most of the cost of a warm search.
 */
const FRESH_MS = 3000;

interface CachedFile {
  mtimeMs: number;
  size: number;
  /** null: binary or too large — remembered, so it is not re-read to learn that again. */
  text: string | null;
  checkedAt: number;
}

/**
 * File contents kept between searches, keyed by absolute path and validated by
 * size and mtime. This is what makes refining a query fast: after the first
 * search, a keystroke re-runs the pattern over text already in memory.
 *
 * Lives in the plugin's host entry, so it only ever holds files from the
 * machine the workspace is on.
 */
export class LocalTextCache {
  private readonly entries = new Map<string, CachedFile>();
  private bytes = 0;

  constructor(
    private readonly budgetBytes = 256 * 1024 * 1024,
    private readonly now: () => number = Date.now,
  ) {}

  async get(absolutePath: string): Promise<string | null> {
    const cached = this.entries.get(absolutePath);
    const now = this.now();
    if (cached !== undefined && now - cached.checkedAt < FRESH_MS) {
      this.touch(absolutePath, cached);
      return cached.text;
    }

    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      this.delete(absolutePath);
      return null;
    }
    if (!info.isFile()) return null;

    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      cached.checkedAt = now;
      this.touch(absolutePath, cached);
      return cached.text;
    }

    let text: string | null = null;
    if (info.size <= MAX_SEARCH_FILE_BYTES) {
      try {
        const bytes = await readFile(absolutePath);
        text = looksBinary(bytes) ? null : bytes.toString("utf8");
      } catch {
        text = null;
      }
    }
    this.set(absolutePath, { mtimeMs: info.mtimeMs, size: info.size, text, checkedAt: now });
    return text;
  }

  /** After a save: the next search must see what was written. */
  delete(absolutePath: string): void {
    const existing = this.entries.get(absolutePath);
    if (existing === undefined) return;
    this.bytes -= weigh(existing);
    this.entries.delete(absolutePath);
  }

  get size(): number {
    return this.entries.size;
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  private set(absolutePath: string, entry: CachedFile): void {
    this.delete(absolutePath);
    this.entries.set(absolutePath, entry);
    this.bytes += weigh(entry);
    // Map iteration is insertion order and every read re-inserts, so the first
    // key is always the least recently used.
    for (const [key, value] of this.entries) {
      if (this.bytes <= this.budgetBytes) break;
      this.entries.delete(key);
      this.bytes -= weigh(value);
    }
  }

  private touch(absolutePath: string, entry: CachedFile): void {
    this.entries.delete(absolutePath);
    this.entries.set(absolutePath, entry);
  }
}

/** JS strings are up to two bytes a character; assume the worst for the budget. */
function weigh(entry: CachedFile): number {
  return (entry.text?.length ?? 0) * 2 + 64;
}

export function createLocalSource(options: {
  root: string;
  list: () => Promise<{ paths: string[]; truncated: boolean }>;
  cache: LocalTextCache;
}): SearchSource {
  return {
    concurrency: 32,
    list: options.list,
    async read(path) {
      if (hasBinaryExtension(path)) return null;
      return options.cache.get(resolveWithinRoot(options.root, path));
    },
  };
}
