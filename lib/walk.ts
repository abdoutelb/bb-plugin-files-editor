import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { FlatEntry } from "./tree.js";

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
 * Recursive listing of a directory on the machine running this code: the
 * plugin's host entry, which BB starts on the machine the workspace lives on.
 * Exclusions are applied while walking, so an excluded `vendor/` or `.git` is
 * never read and never counts toward `limit`.
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

  while (queue.length > 0) {
    const next = queue.shift()!;
    let dirents;
    try {
      dirents = await fs.readdir(next.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    if (!visit(dirents, next.absolute, next.prefix)) break;
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
