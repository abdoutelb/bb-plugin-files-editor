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
 * Only ever holds files from the machine this server runs on — node:fs reads
 * THIS disk, so the caller must not use it for a connected machine's paths.
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

/**
 * A connected machine, through BB's file API. There is no cheap way to ask it
 * "has this changed", so remote text is kept for a short while and searching is
 * bounded — every file is a round trip.
 */
export const REMOTE_SEARCH_FILE_LIMIT = 3000;
const REMOTE_TTL_MS = 60_000;

export class RemoteTextCache {
  private readonly entries = new Map<string, { text: string | null; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): string | null | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() - entry.at > REMOTE_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.text;
  }

  set(key: string, text: string | null): void {
    this.entries.set(key, { text, at: this.now() });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

export function createRemoteSource(options: {
  root: string;
  hostId: string;
  list: () => Promise<{ paths: string[]; truncated: boolean }>;
  readRemote: (absolutePath: string) => Promise<{ text: string | null }>;
  cache: RemoteTextCache;
}): SearchSource {
  return {
    concurrency: 8,
    async list() {
      const listed = await options.list();
      if (listed.paths.length <= REMOTE_SEARCH_FILE_LIMIT) return listed;
      return { paths: listed.paths.slice(0, REMOTE_SEARCH_FILE_LIMIT), truncated: true };
    },
    async read(path) {
      if (hasBinaryExtension(path)) return null;
      const absolutePath = resolveWithinRoot(options.root, path);
      const key = `${options.hostId}\u0000${absolutePath}`;
      const cached = options.cache.get(key);
      if (cached !== undefined) return cached;
      const { text } = await options.readRemote(absolutePath);
      options.cache.set(key, text);
      return text;
    },
  };
}
