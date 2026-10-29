import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { FlatEntry } from "./tree.js";

const WALK_CONCURRENCY = 32;

export interface WalkOptions {
  root: string;
  excludedNames: ReadonlySet<string>;
  includeHidden: boolean;
  limit: number;
}

export interface WalkResult {
  entries: FlatEntry[];
  truncated: boolean;
}

/**
 * Recursive listing of a directory that lives on the machine running this
 * plugin. BB's own `files.listPaths` silently drops every dotfile, so a
 * workspace listed through it has no `.github`, `.env`, or `.gitignore` — this
 * walk exists so a local workspace really does show all of its files.
 *
 * Breadth-first by directory: when a workspace is larger than `limit`, what
 * survives is the shallow part of the tree rather than an arbitrary deep
 * branch.
 *
 * Symlinks are skipped rather than followed, which is both what BB does and
 * what keeps a cyclic link from hanging the walk.
 *
 * Throws if the ROOT cannot be read — a workspace that was deleted underneath
 * BB must not be reported as an empty one. Directories that fail mid-walk are
 * skipped, since the rest of the tree is still worth returning.
 */
export async function walkDirectory(options: WalkOptions): Promise<WalkResult> {
  const entries: FlatEntry[] = [];
  // Relative prefixes are accumulated with "/" rather than derived from
  // path.relative, so a POSIX file whose name contains a backslash keeps it
  // instead of being folded into a separator.
  const queue: Array<{ absolute: string; prefix: string }> = [];
  let truncated = false;

  /** Returns false once the entry cap is hit, to stop the walk. */
  const visit = (
    dirents: readonly Dirent[],
    directory: string,
    prefix: string,
  ): boolean => {
    for (const dirent of dirents) {
      const name = dirent.name;
      if (options.excludedNames.has(name)) continue;
      if (!options.includeHidden && name.startsWith(".")) continue;
      if (dirent.isSymbolicLink()) continue;

      const isDirectory = dirent.isDirectory();
      if (!isDirectory && !dirent.isFile()) continue;

      if (entries.length >= options.limit) {
        truncated = true;
        return false;
      }

      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      entries.push({
        path: relativePath,
        kind: isDirectory ? "directory" : "file",
      });
      if (isDirectory) {
        queue.push({
          absolute: path.join(directory, name),
          prefix: relativePath,
        });
      }
    }
    return true;
  };

  // Deliberately uncaught: a root that cannot be read is an error, not an
  // empty workspace.
  const rootDirents = await fs.readdir(options.root, { withFileTypes: true });
  if (!visit(rootDirents, options.root, "")) return { entries, truncated };

  // Directories are read WALK_CONCURRENCY at a time but visited in queue order,
  // so the result stays the same breadth-first listing a serial walk produces.
  // `head` instead of `shift()`: shifting a 10k-entry queue is O(n) each time.
  let head = 0;
  walk: while (head < queue.length) {
    const batch = queue.slice(head, head + WALK_CONCURRENCY);
    head += batch.length;
    const listed = await Promise.all(
      batch.map((next) =>
        fs.readdir(next.absolute, { withFileTypes: true }).catch(() => null),
      ),
    );
    for (let index = 0; index < batch.length; index += 1) {
      const dirents = listed[index];
      if (dirents === null || dirents === undefined) continue;
      const next = batch[index]!;
      if (!visit(dirents, next.absolute, next.prefix)) break walk;
    }
  }

  return { entries, truncated };
}

export function parseExcludedNames(value: string): Set<string> {
  const names = value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return new Set(names);
}

/**
 * Whether a failed local walk should be retried through BB's own listing.
 *
 * BB answers a missing directory with an empty success rather than an error, so
 * handing it a root that is gone would turn a deleted workspace into one that
 * merely looks empty — the exact failure {@link walkDirectory}'s uncaught root
 * read exists to prevent. A root we simply cannot read from this process
 * (permissions, descriptor exhaustion) is worth a second opinion, because BB
 * can reach the host when `node:fs` cannot.
 */
export function shouldFallBackToBbListing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== "ENOENT" && code !== "ENOTDIR";
}
