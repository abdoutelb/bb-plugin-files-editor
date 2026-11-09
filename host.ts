import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { ENTRY_LIMIT, hostContract } from "./lib/host-contract.js";
import {
  createInProcessExecutor,
  createWorkerExecutor,
} from "./lib/regex-worker.js";
import { runSearch } from "./lib/search-run.js";
import { LocalTextCache, createLocalSource } from "./lib/search-sources.js";
import { walkDirectory } from "./lib/walk.js";

/**
 * Runs on the machine the workspace lives on, so every read is a local
 * `node:fs` read. Held for the life of this worker: contents read by one
 * search are there for the next, and are re-validated by size and mtime, so
 * an agent's edit shows up within a few seconds.
 */
const texts = new LocalTextCache();

// The file list is re-walked at most this often while someone is typing.
const SEARCH_LIST_FRESH_MS = 3000;
const searchListings = new Map<
  string,
  { at: number; paths: string[]; truncated: boolean }
>();

// One search in flight per workspace: a keystroke supersedes the last one.
const runningSearches = new Map<string, AbortController>();

const SEARCH_LIMITS = { maxMatches: 2000, maxFiles: 500, timeBudgetMs: 10_000 };

interface Listing {
  root: string;
  includeHidden: boolean;
  excludedNames: readonly string[];
}

function walk(listing: Listing) {
  return walkDirectory({
    root: listing.root,
    excludedNames: new Set(listing.excludedNames),
    includeHidden: listing.includeHidden,
    limit: ENTRY_LIMIT,
  });
}

async function listSearchPaths(
  listing: Listing,
): Promise<{ paths: string[]; truncated: boolean }> {
  const excluded = [...listing.excludedNames].sort().join("\u0000");
  const key = `${listing.root}\u0000${listing.includeHidden}\u0000${excluded}`;
  const cached = searchListings.get(key);
  if (cached !== undefined && Date.now() - cached.at < SEARCH_LIST_FRESH_MS) {
    return cached;
  }
  const listed = await walk(listing);
  const paths = listed.entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path)
    // Path order, so results read top to bottom the way the tree does and
    // the same query always shows the same first page.
    .sort((left, right) => left.localeCompare(right));
  const fresh = { at: Date.now(), paths, truncated: listed.truncated };
  searchListings.set(key, fresh);
  return fresh;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    list: (input) => walk(input),

    async search(input, context) {
      runningSearches.get(input.root)?.abort();
      const controller = new AbortController();
      runningSearches.set(input.root, controller);

      try {
        return await runSearch({
          source: createLocalSource({
            root: input.root,
            list: () => listSearchPaths(input),
            cache: texts,
          }),
          query: {
            query: input.query,
            matchCase: input.matchCase,
            wholeWord: input.wholeWord,
            regex: input.regex,
          },
          limits: SEARCH_LIMITS,
          signal: AbortSignal.any([controller.signal, context.signal]),
          now: () => performance.now(),
          createExecutor: (pattern, flags, isUserRegex) =>
            isUserRegex
              ? createWorkerExecutor(pattern, flags)
              : createInProcessExecutor(pattern, flags),
        });
      } finally {
        if (runningSearches.get(input.root) === controller) {
          runningSearches.delete(input.root);
        }
      }
    },

    forget({ absolutePath }) {
      texts.delete(absolutePath);
      return null;
    },
  },
});
