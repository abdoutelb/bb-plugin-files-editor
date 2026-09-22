import {
  buildPattern,
  toLineMatches,
  type LineMatch,
  type SearchQuery,
} from "./text-search.js";
import { PatternTooSlowError, type MatchExecutor } from "./regex-worker.js";

/**
 * Where the files come from. The run itself does no I/O, so the same pipeline
 * serves a local checkout (node:fs, with a cache) and a connected machine
 * (BB's file API) — and runs in tests against a plain map.
 */
export interface SearchSource {
  /** Workspace-relative file paths, exclusions already applied. */
  list(): Promise<{ paths: string[]; truncated: boolean }>;
  /** The file's text, or null to skip it: binary, too large, or unreadable. */
  read(path: string): Promise<string | null>;
  /** Files read at once. */
  concurrency: number;
}

export interface SearchLimits {
  maxMatches: number;
  maxFiles: number;
  timeBudgetMs: number;
}

export interface FileResult {
  path: string;
  matchCount: number;
  matches: LineMatch[];
}

export type StopReason = "matches" | "files" | "time" | "listing";

export type SearchOutcome =
  | {
      status: "ok";
      files: FileResult[];
      totalMatches: number;
      searchedFiles: number;
      truncated: boolean;
      reason: StopReason | null;
      durationMs: number;
    }
  | { status: "error"; message: string }
  | { status: "cancelled" };

export interface RunOptions {
  source: SearchSource;
  query: SearchQuery;
  limits: SearchLimits;
  signal: AbortSignal;
  now: () => number;
  /** Chooses where the pattern runs; regex queries should not share the server's thread. */
  createExecutor: (source: string, flags: string, isUserRegex: boolean) => MatchExecutor;
}

const CANCELLED = { status: "cancelled" } as const;

export async function runSearch(options: RunOptions): Promise<SearchOutcome> {
  const { source, query, limits, signal, now } = options;
  const built = buildPattern(query);
  if (!built.ok) return { status: "error", message: built.error };

  const started = now();
  const listing = await source.list();
  if (signal.aborted) return CANCELLED;

  const executor = options.createExecutor(built.source, built.flags, query.regex);
  const files: FileResult[] = [];
  let totalMatches = 0;
  let searchedFiles = 0;
  let reason: StopReason | null = listing.truncated ? "listing" : null;

  try {
    const { paths } = listing;
    outer: for (let start = 0; start < paths.length; start += source.concurrency) {
      if (signal.aborted) return CANCELLED;
      if (now() - started > limits.timeBudgetMs) {
        reason = "time";
        break;
      }

      const batch = paths.slice(start, start + source.concurrency);
      const texts = await Promise.all(
        batch.map((path) => source.read(path).catch(() => null)),
      );
      // The await is where a newer query gets its chance to supersede this one.
      if (signal.aborted) return CANCELLED;

      const present: string[] = [];
      const presentTexts: string[] = [];
      batch.forEach((path, index) => {
        const text = texts[index];
        if (text !== null && text !== undefined) {
          present.push(path);
          presentTexts.push(text);
        }
      });
      searchedFiles += present.length;
      if (present.length === 0) continue;

      const perFile = await executor.exec(presentTexts, limits.maxMatches - totalMatches);
      for (let index = 0; index < present.length; index += 1) {
        const hits = perFile[index] ?? [];
        if (hits.length === 0) continue;
        files.push({
          path: present[index]!,
          matchCount: hits.length,
          matches: toLineMatches(presentTexts[index]!, hits),
        });
        totalMatches += hits.length;
        if (totalMatches >= limits.maxMatches) {
          reason = "matches";
          break outer;
        }
        if (files.length >= limits.maxFiles) {
          reason = "files";
          break outer;
        }
      }
    }
  } catch (error) {
    if (error instanceof PatternTooSlowError) {
      return {
        status: "error",
        message:
          "That pattern is too slow to run — it backtracks badly on some of these files. Try a simpler one.",
      };
    }
    throw error;
  } finally {
    executor.dispose();
  }

  return {
    status: "ok",
    files,
    totalMatches,
    searchedFiles,
    truncated: reason !== null,
    reason,
    durationMs: Math.round(now() - started),
  };
}
