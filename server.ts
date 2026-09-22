import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineRpcContract,
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { FlatEntry } from "./lib/tree.js";
import { rankEntries } from "./lib/tree.js";
import { resolveWithinRoot } from "./lib/paths.js";
import {
  parseExcludedNames,
  shouldFallBackToBbListing,
  walkDirectory,
} from "./lib/walk.js";
import { clipForCli, clipLinesForCli } from "./lib/cli-output.js";
import {
  createInProcessExecutor,
  createWorkerExecutor,
} from "./lib/regex-worker.js";
import { runSearch } from "./lib/search-run.js";
import {
  LocalTextCache,
  MAX_SEARCH_FILE_BYTES,
  RemoteTextCache,
  createLocalSource,
  createRemoteSource,
} from "./lib/search-sources.js";

/** BB's own recursive listing is capped at 10k; the local walk gets more room. */
const LOCAL_ENTRY_LIMIT = 40_000;
const REMOTE_ENTRY_LIMIT = 10_000;

/** Text past this is shown read-only — a textarea stops being usable long before. */
const MAX_EDITABLE_BYTES = 4 * 1024 * 1024;

/** Inline images round-trip as base64 through RPC, so keep them modest. */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

// The three dependency directories big enough to truncate a listing on their
// own, across the JS, PHP and Go worlds. Editable in settings.
const DEFAULT_EXCLUDED_DIRECTORIES = ".git\nnode_modules\nvendor";

const CHANGED_CHANNEL = "files-editor/changed";

const scopeSchema = z
  .object({
    kind: z.enum(["thread", "environment", "project"]),
    id: z.string().min(1),
  })
  .strict();

type Scope = z.infer<typeof scopeSchema>;

const workspaceSchema = z.object({
  ref: scopeSchema,
  label: z.string(),
  sublabel: z.string(),
  projectId: z.string(),
  kind: z.enum(["project", "environment"]),
});

const entrySchema = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
});

const resolvedScopeSchema = z.object({
  root: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  isLocal: z.boolean(),
  label: z.string(),
  sublabel: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  ref: scopeSchema,
});

const lineMatchSchema = z.object({
  line: z.number(),
  column: z.number(),
  preview: z.string(),
  ranges: z.array(z.tuple([z.number(), z.number()])),
  clippedStart: z.boolean(),
  clippedEnd: z.boolean(),
});

const searchOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    files: z.array(
      z.object({
        path: z.string(),
        matchCount: z.number(),
        matches: z.array(lineMatchSchema),
      }),
    ),
    totalMatches: z.number(),
    searchedFiles: z.number(),
    truncated: z.boolean(),
    reason: z.enum(["matches", "files", "time", "listing"]).nullable(),
    durationMs: z.number(),
    listing: z.enum(["local", "remote"]),
  }),
  z.object({ status: z.literal("error"), message: z.string() }),
  z.object({ status: z.literal("cancelled") }),
]);

export type SearchResult = z.infer<typeof searchOutcomeSchema>;

export const rpcContract = defineRpcContract({
  workspaces: {
    input: z.null(),
    output: z.object({
      workspaces: z.array(workspaceSchema),
      defaultRef: scopeSchema.nullable(),
    }),
  },
  resolve: {
    input: z.object({ scope: scopeSchema }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), scope: resolvedScopeSchema }),
      z.object({ ok: z.literal(false), reason: z.string() }),
    ]),
  },
  tree: {
    input: z
      .object({ scope: scopeSchema, includeHidden: z.boolean() })
      .strict(),
    output: z.object({
      scope: resolvedScopeSchema,
      entries: z.array(entrySchema),
      truncated: z.boolean(),
      /** `remote` listings cannot include dotfiles — BB's API drops them. */
      listing: z.enum(["local", "remote"]),
      excluded: z.array(z.string()),
    }),
  },
  read: {
    input: z.object({ scope: scopeSchema, path: z.string().min(1) }).strict(),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        content: z.string(),
        sha256: z.string(),
        sizeBytes: z.number(),
        absolutePath: z.string(),
        editable: z.boolean(),
      }),
      z.object({
        kind: z.literal("image"),
        dataUrl: z.string(),
        sizeBytes: z.number(),
        absolutePath: z.string(),
      }),
      z.object({
        kind: z.literal("binary"),
        sizeBytes: z.number(),
        absolutePath: z.string(),
        reason: z.string(),
      }),
    ]),
  },
  /** Text search across every file in the workspace — not a file-name search. */
  searchText: {
    input: z
      .object({
        scope: scopeSchema,
        query: z.string().max(1000),
        matchCase: z.boolean(),
        wholeWord: z.boolean(),
        regex: z.boolean(),
        includeHidden: z.boolean(),
      })
      .strict(),
    output: searchOutcomeSchema,
  },
  /** A lease for the plugin's own `docs/` directory, for the settings page. */
  preview: {
    input: z.null(),
    output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }),
  },
  write: {
    input: z
      .object({
        scope: scopeSchema,
        path: z.string().min(1),
        content: z.string(),
        /**
         * The hash the edit was based on, guarding against an agent having
         * written the file in the meantime. Omit it to overwrite regardless.
         * (`null` is deliberately not accepted: BB reads it as create-only,
         * which would conflict on every existing file.)
         */
        expectedSha256: z.string().optional(),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("written"),
        sha256: z.string(),
        sizeBytes: z.number(),
      }),
      z.object({
        outcome: z.literal("conflict"),
        currentSha256: z.string().nullable(),
      }),
    ]),
  },
});

/** A browsable directory: what a scope reference turns into. */
export type ResolvedScope = z.infer<typeof resolvedScopeSchema>;
export type WorkspaceOption = z.infer<typeof workspaceSchema>;

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    excludedDirectories: {
      type: "string",
      label: "Excluded directories (one name per line)",
      experimental_multiline: true,
      default: DEFAULT_EXCLUDED_DIRECTORIES,
    },
  });

  async function excludedNames(): Promise<Set<string>> {
    const { excludedDirectories } = await settings.get();
    return parseExcludedNames(excludedDirectories);
  }

  let cachedLocalHostId: string | null = null;

  /**
   * The daemon running on THIS machine, read from the id file BB's own
   * primary-host resolution trusts first.
   *
   * `system.config().primaryHostId` is deliberately not used as a locality
   * test: when the data directory has no id file BB falls back to "the only
   * connected host", which on a headless server is somebody else's laptop.
   * Walking that host's paths with node:fs would read the server's disk and
   * quietly serve the wrong machine's files.
   */
  async function localHostId(): Promise<string | null> {
    if (cachedLocalHostId !== null) return cachedLocalHostId;
    const { dataDir } = await bb.sdk.system.config();
    try {
      const value = (
        await readFile(path.join(dataDir, "host-id"), "utf8")
      ).trim();
      // Only a successful read is cached, so a daemon that initialises after
      // this plugin loaded is picked up on the next call.
      if (value !== "") cachedLocalHostId = value;
      return cachedLocalHostId;
    } catch {
      return null;
    }
  }

  async function hostName(hostId: string): Promise<string> {
    try {
      const host = await bb.sdk.hosts.get({ hostId });
      return host.name;
    } catch {
      return "this machine";
    }
  }

  /**
   * `projects.get` serves standard projects only — asking it for the singleton
   * personal project is a 404 — so fall back to the list that can include it.
   */
  async function project(projectId: string) {
    try {
      return await bb.sdk.projects.get({ projectId });
    } catch {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return projects.find((entry) => entry.id === projectId) ?? null;
    }
  }

  async function projectRoot(
    projectId: string,
  ): Promise<{ root: string; hostId: string; name: string } | string> {
    const found = await project(projectId);
    if (found === null) return "That project no longer exists.";

    const source =
      found.sources.find((entry) => entry.isDefault) ?? found.sources[0];
    if (source === undefined) {
      return `${found.name} has no checkout on any machine yet.`;
    }
    return { root: source.path, hostId: source.hostId, name: found.name };
  }

  /** Turn whatever the caller pointed at into one browsable directory. */
  async function resolveScope(
    scope: Scope,
  ): Promise<{ ok: true; scope: ResolvedScope } | { ok: false; reason: string }> {
    let environmentId: string | null = null;
    let projectId: string | null = null;

    if (scope.kind === "thread") {
      const thread = await bb.sdk.threads.get({ threadId: scope.id });
      environmentId = thread.environmentId;
      projectId = thread.projectId;
    } else if (scope.kind === "environment") {
      environmentId = scope.id;
    } else {
      projectId = scope.id;
    }

    if (environmentId !== null) {
      const environment = await bb.sdk.environments.get({ environmentId });
      if (environment.path !== null) {
        const owner = await project(environment.projectId);
        const local = await localHostId();
        return {
          ok: true,
          scope: {
            root: environment.path,
            hostId: environment.hostId,
            hostName: await hostName(environment.hostId),
            isLocal: environment.hostId === local,
            label: owner?.name ?? "Workspace",
            sublabel:
              environment.branchName ??
              environment.name ??
              (environment.workspaceProvisionType === "personal"
                ? "personal workspace"
                : "workspace"),
            projectId: environment.projectId,
            environmentId,
            ref: scope,
          },
        };
      }
      // A provisioning or torn-down environment has no directory yet. Fall
      // through to the project checkout so the panel still shows something.
      if (projectId === null) projectId = environment.projectId;
    }

    if (projectId === null) {
      return { ok: false, reason: "This thread has no workspace yet." };
    }

    const resolved = await projectRoot(projectId);
    if (typeof resolved === "string") return { ok: false, reason: resolved };

    const local = await localHostId();
    return {
      ok: true,
      scope: {
        root: resolved.root,
        hostId: resolved.hostId,
        hostName: await hostName(resolved.hostId),
        isLocal: resolved.hostId === local,
        label: resolved.name,
        sublabel: "project checkout",
        projectId,
        environmentId: null,
        ref: scope,
      },
    };
  }

  async function listEntries(
    scope: ResolvedScope,
    includeHidden: boolean,
  ): Promise<{
    entries: FlatEntry[];
    truncated: boolean;
    listing: "local" | "remote";
  }> {
    const excluded = await excludedNames();

    if (scope.isLocal) {
      try {
        const result = await walkDirectory({
          root: scope.root,
          excludedNames: excluded,
          includeHidden,
          limit: LOCAL_ENTRY_LIMIT,
        });
        return { ...result, listing: "local" };
      } catch (error) {
        if (!shouldFallBackToBbListing(error)) throw error;
        // The id file said this machine but the directory is not readable here
        // (EACCES, EPERM, EMFILE). Let BB try — it knows how to reach the host
        // even when node:fs cannot.
        bb.log.warn(
          `local walk of ${scope.root} failed (${describe(error)}); falling back to BB's listing`,
        );
      }
    }

    // Remote workspaces go through BB, which walks the host daemon. It applies
    // its own dotfile and node_modules filtering that a plugin cannot turn off.
    const result = await bb.sdk.files.listPaths({
      hostId: scope.hostId,
      path: scope.root,
      includeFiles: true,
      includeDirectories: true,
      limit: REMOTE_ENTRY_LIMIT,
    });
    const entries = result.paths
      .map((entry) => ({ path: entry.path, kind: entry.kind }))
      .filter((entry) => !isExcluded(entry.path, excluded));
    return { entries, truncated: result.truncated, listing: "remote" };
  }

  async function readWorkspaceFile(scope: ResolvedScope, relativePath: string) {
    const absolutePath = resolveWithinRoot(scope.root, relativePath);
    const file = await bb.sdk.files.read({
      hostId: scope.hostId,
      path: absolutePath,
      rootPath: scope.root,
    });

    if (file.contentEncoding === "utf8") {
      return {
        kind: "text" as const,
        content: file.content,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        absolutePath,
        editable: file.sizeBytes <= MAX_EDITABLE_BYTES,
      };
    }

    const mimeType = file.mimeType;
    if (mimeType !== undefined && mimeType.startsWith("image/")) {
      if (file.sizeBytes > MAX_INLINE_IMAGE_BYTES) {
        return {
          kind: "binary" as const,
          sizeBytes: file.sizeBytes,
          absolutePath,
          reason: "This image is too large to preview here.",
        };
      }
      return {
        kind: "image" as const,
        dataUrl: `data:${mimeType};base64,${file.content}`,
        sizeBytes: file.sizeBytes,
        absolutePath,
      };
    }

    return {
      kind: "binary" as const,
      sizeBytes: file.sizeBytes,
      absolutePath,
      reason: "This file is not text.",
    };
  }

  const PREVIEW_TTL_MS = 60 * 60 * 1000;
  const PREVIEW_REFRESH_MARGIN_MS = 5 * 60 * 1000;
  let previewCache: { baseUrl: string; expiresAtMs: number } | null = null;

  /**
   * `docs/` served over a confined preview URL — the transport BB documents for
   * plugin images. Sits beside the entry in a source checkout and one level up
   * from `dist/` in a built install, so both layouts are probed.
   */
  async function previewLease() {
    const now = Date.now();
    if (
      previewCache !== null &&
      previewCache.expiresAtMs - now > PREVIEW_REFRESH_MARGIN_MS
    ) {
      return previewCache;
    }
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const root = [
      path.join(moduleDir, "docs"),
      path.join(moduleDir, "..", "docs"),
    ].find((candidate) => existsSync(path.join(candidate, "preview.png")));
    if (root === undefined) throw new Error("The preview image is not installed.");

    previewCache = await bb.sdk.files.createPreview({
      rootPath: root,
      ttlMs: PREVIEW_TTL_MS,
    });
    return previewCache;
  }

  // --- project-wide text search -------------------------------------------
  //
  // Held for the life of this load, so contents read by one search are there
  // for the next. A reload builds fresh ones.
  const localTexts = new LocalTextCache();
  const remoteTexts = new RemoteTextCache();
  // The file list is re-walked at most this often while someone is typing.
  const SEARCH_LIST_FRESH_MS = 3000;
  const searchListings = new Map<
    string,
    { at: number; paths: string[]; truncated: boolean }
  >();
  // One search in flight per workspace: a keystroke supersedes the last one.
  const runningSearches = new Map<string, AbortController>();

  const SEARCH_LIMITS = { maxMatches: 2000, maxFiles: 500, timeBudgetMs: 10_000 };

  async function listSearchPaths(
    scope: ResolvedScope,
    includeHidden: boolean,
  ): Promise<{ paths: string[]; truncated: boolean }> {
    const excluded = [...(await excludedNames())].sort().join("\u0000");
    const key = `${scope.hostId}\u0000${scope.root}\u0000${includeHidden}\u0000${excluded}`;
    const cached = searchListings.get(key);
    if (cached !== undefined && Date.now() - cached.at < SEARCH_LIST_FRESH_MS) {
      return cached;
    }
    const listed = await listEntries(scope, includeHidden);
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

  function forgetSearchedFile(scope: ResolvedScope, absolutePath: string): void {
    if (scope.isLocal) localTexts.delete(absolutePath);
    else remoteTexts.delete(`${scope.hostId}\u0000${absolutePath}`);
  }

  bb.rpc.register(rpcContract, {
    async workspaces() {
      // One request gives every project, its checkouts, and the environments
      // its threads run in — which is where a worktree's branch name lives.
      const projects = await bb.sdk.projects.list({
        include: "threads",
        includePersonal: true,
      });

      const workspaces: z.infer<typeof workspaceSchema>[] = [];
      for (const project of projects) {
        if (project.sources.length > 0) {
          workspaces.push({
            ref: { kind: "project", id: project.id },
            label: project.name,
            sublabel:
              project.kind === "personal"
                ? "personal files"
                : "project checkout",
            projectId: project.id,
            kind: "project",
          });
        }

        const threads = "threads" in project ? project.threads : [];
        const seen = new Set<string>();
        for (const thread of threads) {
          const environmentId = thread.environmentId;
          if (environmentId === null || seen.has(environmentId)) continue;
          if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
          if (thread.environmentWorkspaceDisplayKind === "other") continue;
          seen.add(environmentId);
          workspaces.push({
            ref: { kind: "environment", id: environmentId },
            label: project.name,
            sublabel:
              thread.environmentBranchName ??
              thread.environmentName ??
              "worktree",
            projectId: project.id,
            kind: "environment",
          });
        }
      }

      return {
        workspaces,
        defaultRef: workspaces[0]?.ref ?? null,
      };
    },

    async searchText({ scope, query, matchCase, wholeWord, regex, includeHidden }) {
      const resolved = await resolveScope(scope);
      if (!resolved.ok) return { status: "error" as const, message: resolved.reason };
      const target = resolved.scope;

      const key = `${scope.kind}:${scope.id}`;
      runningSearches.get(key)?.abort();
      const controller = new AbortController();
      runningSearches.set(key, controller);

      const list = () => listSearchPaths(target, includeHidden);
      const source = target.isLocal
        ? createLocalSource({ root: target.root, list, cache: localTexts })
        : createRemoteSource({
            root: target.root,
            hostId: target.hostId,
            list,
            cache: remoteTexts,
            async readRemote(absolutePath) {
              const file = await bb.sdk.files.read({
                hostId: target.hostId,
                path: absolutePath,
                rootPath: target.root,
              });
              const usable =
                file.contentEncoding === "utf8" && file.sizeBytes <= MAX_SEARCH_FILE_BYTES;
              return { text: usable ? file.content : null };
            },
          });

      try {
        const outcome = await runSearch({
          source,
          query: { query, matchCase, wholeWord, regex },
          limits: SEARCH_LIMITS,
          signal: controller.signal,
          now: () => performance.now(),
          createExecutor: (pattern, flags, isUserRegex) =>
            isUserRegex
              ? createWorkerExecutor(pattern, flags)
              : createInProcessExecutor(pattern, flags),
        });
        if (outcome.status !== "ok") return outcome;
        return { ...outcome, listing: target.isLocal ? ("local" as const) : ("remote" as const) };
      } finally {
        if (runningSearches.get(key) === controller) runningSearches.delete(key);
      }
    },

    preview: () => previewLease(),

    async resolve({ scope }) {
      return resolveScope(scope);
    },

    async tree({ scope, includeHidden }) {
      const resolved = await resolveScope(scope);
      if (!resolved.ok) throw new Error(resolved.reason);
      const listed = await listEntries(resolved.scope, includeHidden);
      return {
        scope: resolved.scope,
        entries: listed.entries,
        truncated: listed.truncated,
        listing: listed.listing,
        excluded: [...(await excludedNames())].sort(),
      };
    },

    async read({ scope, path: relativePath }) {
      const resolved = await resolveScope(scope);
      if (!resolved.ok) throw new Error(resolved.reason);
      return readWorkspaceFile(resolved.scope, relativePath);
    },

    async write({ scope, path: relativePath, content, expectedSha256 }) {
      const resolved = await resolveScope(scope);
      if (!resolved.ok) throw new Error(resolved.reason);

      const absolutePath = resolveWithinRoot(resolved.scope.root, relativePath);
      const result = await bb.sdk.files.write({
        hostId: resolved.scope.hostId,
        path: absolutePath,
        rootPath: resolved.scope.root,
        content,
        contentEncoding: "utf8",
        // Present = compare-and-swap; absent = unconditional.
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      });

      if (result.outcome === "conflict") {
        return {
          outcome: "conflict" as const,
          currentSha256: result.currentSha256,
        };
      }

      // The next search must see what was just written, not the cached copy.
      forgetSearchedFile(resolved.scope, absolutePath);
      bb.realtime.publish(CHANGED_CHANNEL, {
        scope,
        path: relativePath,
        sha256: result.sha256,
      });
      bb.log.info(`wrote ${absolutePath}`);
      return {
        outcome: "written" as const,
        sha256: result.sha256,
        sizeBytes: result.sizeBytes,
      };
    },
  });

  bb.cli.register({
    name: "files",
    summary: "Browse and read the files of a thread's workspace",
    commands: [
      {
        name: "tree",
        summary: "List the workspace's files",
        usage: "bb files tree [--depth <n>] [--all] [--limit <n>]",
      },
      {
        name: "find",
        summary: "Fuzzy-find files by path",
        usage: "bb files find <query> [--limit <n>]",
      },
      {
        name: "read",
        summary: "Print a file relative to the workspace root",
        usage: "bb files read <path>",
      },
      {
        name: "root",
        summary: "Print the resolved workspace root and machine",
        usage: "bb files root",
      },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      const flags = readFlags(rest);

      const scope: Scope | null =
        ctx.threadId !== undefined
          ? { kind: "thread", id: ctx.threadId }
          : ctx.projectId !== undefined
            ? { kind: "project", id: ctx.projectId }
            : null;
      if (scope === null) {
        return {
          exitCode: 1,
          stderr: "No thread or project in context; run this inside a thread.\n",
        };
      }

      const resolved = await resolveScope(scope);
      if (!resolved.ok) {
        return { exitCode: 1, stderr: `${resolved.reason}\n` };
      }

      switch (command) {
        case "root":
          return {
            exitCode: 0,
            stdout: `${resolved.scope.root}\nmachine: ${resolved.scope.hostName}\n`,
          };

        case "tree": {
          const listed = await listEntries(
            resolved.scope,
            flags.boolean.has("all"),
          );
          const depth = flags.number("depth") ?? Number.POSITIVE_INFINITY;
          const limit = flags.number("limit") ?? 500;
          const shown = listed.entries
            .filter((entry) => entry.path.split("/").length <= depth)
            .slice(0, limit);
          const lines = shown.map((entry) =>
            entry.kind === "directory" ? `${entry.path}/` : entry.path,
          );
          const notes: string[] = [];
          if (shown.length < listed.entries.length) {
            notes.push(
              `(showing ${shown.length} of ${listed.entries.length} entries)`,
            );
          }
          if (listed.truncated) notes.push("(listing was truncated)");
          const clipped = clipLinesForCli(lines, CLI_LISTING_BUDGET);
          if (clipped.omitted > 0) {
            notes.push(
              `(output capped: printed ${lines.length - clipped.omitted} of ${lines.length} entries — BB caps a command's output)`,
            );
          }
          return {
            exitCode: 0,
            stdout: `${clipped.text}${notes.map((note) => `${note}\n`).join("")}`,
          };
        }

        case "find": {
          const query = flags.positional.join(" ");
          if (query === "") {
            return { exitCode: 1, stderr: "Usage: bb files find <query>\n" };
          }
          const listed = await listEntries(resolved.scope, true);
          const files = listed.entries.filter((entry) => entry.kind === "file");
          const ranked = rankEntries(files, query, flags.number("limit") ?? 40);
          if (ranked.matches.length === 0) {
            return { exitCode: 0, stdout: `No file matches ${query}\n` };
          }
          const clipped = clipLinesForCli(
            ranked.matches.map((match) => match.path),
            CLI_LISTING_BUDGET,
          );
          return {
            exitCode: 0,
            stdout: clipped.text,
            ...(clipped.omitted === 0
              ? {}
              : {
                  stderr: `(output capped: ${clipped.omitted} more matches omitted — BB caps a command's output)\n`,
                }),
          };
        }

        case "read": {
          const target = flags.positional[0];
          if (target === undefined) {
            return { exitCode: 1, stderr: "Usage: bb files read <path>\n" };
          }
          const file = await readWorkspaceFile(resolved.scope, target);
          if (file.kind !== "text") {
            return {
              exitCode: 1,
              stderr: `${target} is not text (${file.kind}).\n`,
            };
          }
          const clipped = clipForCli(file.content, CLI_OUTPUT_BUDGET);
          return {
            exitCode: 0,
            stdout: clipped.text,
            ...(clipped.clippedFrom === null
              ? {}
              : {
                  stderr: `(truncated: printed ${CLI_OUTPUT_BUDGET} of ${clipped.clippedFrom} bytes — BB caps a command's output)\n`,
                }),
          };
        }

        default:
          return {
            exitCode: 1,
            stderr:
              "Usage: bb files <root|tree|find|read> [...]\nRun `bb files root` to see the resolved workspace.\n",
          };
      }
    },
  });
}

function isExcluded(entryPath: string, excluded: ReadonlySet<string>): boolean {
  return entryPath.split("/").some((segment) => excluded.has(segment));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The host rejects an oversized CLI result outright rather than clipping it.
 * The budget leaves room for the note appended on stderr.
 */
const CLI_OUTPUT_BUDGET = PLUGIN_CLI_OUTPUT_MAX_BYTES - 4096;
// A listing also prints trailing notes, so leave them room inside the budget.
const CLI_LISTING_BUDGET = CLI_OUTPUT_BUDGET - 1024;

interface Flags {
  positional: string[];
  boolean: Set<string>;
  number(name: string): number | undefined;
}

function readFlags(argv: readonly string[]): Flags {
  const positional: string[] = [];
  const booleans = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      booleans.add(name);
    }
  }

  return {
    positional,
    boolean: booleans,
    number(name) {
      const raw = values.get(name);
      if (raw === undefined) return undefined;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    },
  };
}
