import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.js";
import type { ScopeRef } from "@/lib/route";
import { sameScope } from "@/lib/route";
import { allowedMode, isMarkdownPath, type FileViewMode } from "@/lib/markdown";

export type FileContent =
  | {
      kind: "text";
      content: string;
      sha256: string;
      sizeBytes: number;
      absolutePath: string;
      editable: boolean;
    }
  | {
      kind: "image";
      dataUrl: string;
      sizeBytes: number;
      absolutePath: string;
    }
  | {
      kind: "binary";
      sizeBytes: number;
      absolutePath: string;
      reason: string;
    };

export type { FileViewMode };

export type SaveState =
  | { kind: "clean" }
  | { kind: "saving" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

export interface FileTab {
  path: string;
  file: FileContent | null;
  error: string | null;
  /** Edited text; null while the tab still matches what was read. */
  draft: string | null;
  /** The hash the draft is based on — the compare-and-swap guard on save. */
  sha256: string | null;
  mode: FileViewMode;
  save: SaveState;
}

/** What the tab would render: the draft over the file, or null with no text. */
export function renderedText(tab: FileTab): string | null {
  if (tab.draft !== null) return tab.draft;
  return tab.file !== null && tab.file.kind === "text" ? tab.file.content : null;
}

/** Whether the tab may be shown in Preview — the rule `setMode` applies. */
export function canPreview(tab: FileTab): boolean {
  return allowedMode("preview", tab.path, renderedText(tab)) === "preview";
}

export function isDirty(tab: FileTab): boolean {
  if (tab.draft === null) return false;
  if (tab.file === null || tab.file.kind !== "text") return false;
  return tab.draft !== tab.file.content;
}

export interface FileTabsApi {
  tabs: FileTab[];
  activePath: string | null;
  activeTab: FileTab | null;
  open(path: string): void;
  /** Returns the tab left in front after the close. */
  close(path: string): string | null;
  /** Closes every other tab; returns the path left active. */
  closeOthers(path: string): string | null;
  /** Closes every tab. */
  closeAll(): void;
  activate(path: string): void;
  setDraft(path: string, draft: string): void;
  setMode(path: string, mode: FileViewMode): void;
  /**
   * Leaves Preview for Read, and leaves Read and Edit alone. For features that
   * address the source by line or offset — find, a search hit — which the
   * rendered pane cannot show.
   */
  showSource(path: string): void;
  save(): void;
  overwrite(): void;
  reload(path?: string): void;
  retry(): void;
  reset(): void;
}

const MAX_TABS = 12;

export function useFileTabs(scope: ScopeRef | null): FileTabsApi {
  const rpc = useRpc<typeof rpcContract>();
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  // Every callback below reads through these rather than through the values it
  // closed over. A `sonner` toast action can be clicked several renders after
  // it was created, and acting on that render's tab array would revert
  // everything that happened since.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // Reads resolve out of order; only the newest one for a path may land. The
  // counter is monotonic for the life of the hook and never reset, so a read
  // issued before a close can never collide with one issued after a reopen.
  const readSequence = useRef(0);
  const inFlightRead = useRef(new Map<string, number>());
  // Writes need the same treatment: a tab that is closed and reopened, or a
  // workspace that is swapped, leaves a pending write whose result would
  // otherwise land on whatever tab now sits at that relative path.
  const writeSequence = useRef(0);
  const inFlightWrite = useRef(new Map<string, number>());
  const scopeRef = useRef(scope);

  useEffect(() => {
    if (sameScope(scopeRef.current, scope)) return;
    scopeRef.current = scope;
    inFlightRead.current.clear();
    inFlightWrite.current.clear();
    setTabs([]);
    setActivePath(null);
  }, [scope]);

  const patch = useCallback(
    (path: string, update: (tab: FileTab) => FileTab) => {
      setTabs((current) =>
        current.map((tab) => (tab.path === path ? update(tab) : tab)),
      );
    },
    [],
  );

  const load = useCallback(
    (path: string) => {
      const activeScope = scopeRef.current;
      if (activeScope === null) return;

      const generation = (readSequence.current += 1);
      inFlightRead.current.set(path, generation);
      patch(path, (tab) => ({ ...tab, error: null }));

      const isCurrent = () =>
        inFlightRead.current.get(path) === generation &&
        sameScope(scopeRef.current, activeScope);

      void rpc
        .call("read", { scope: activeScope, path })
        .then((file) => {
          if (!isCurrent()) return;
          patch(path, (tab) => ({
            ...tab,
            file,
            error: null,
            draft: null,
            sha256: file.kind === "text" ? file.sha256 : null,
            // A tab opens in preview off its name alone. This is the first
            // moment its size is known, and a document too large to render has
            // to fall back to source rather than freeze the surface.
            mode: allowedMode(
              tab.mode,
              path,
              file.kind === "text" ? file.content : null,
            ),
            save: { kind: "clean" },
          }));
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          patch(path, (tab) => ({
            ...tab,
            error: messageOf(error, "Could not open this file"),
          }));
        });
    },
    [patch, rpc],
  );

  const open = useCallback(
    (path: string) => {
      setActivePath(path);
      // Decide from the live ref, NOT from inside the setTabs updater: the
      // updater runs during the next render, so a flag set there is still unset
      // by the time this function continues and the read would never fire.
      if (tabsRef.current.some((tab) => tab.path === path)) return;

      const tab: FileTab = {
        path,
        file: null,
        error: null,
        draft: null,
        sha256: null,
        // The read has not been issued yet, so the path is all there is to go
        // on: markdown is worth reading rendered, everything else is source.
        // Whether the file is small enough to render is settled in `load`.
        mode: isMarkdownPath(path) ? "preview" : "read",
        save: { kind: "clean" },
      };
      setTabs((current) => {
        if (current.some((existing) => existing.path === path)) return current;
        const next = [...current, tab];
        // Drop the oldest clean tab rather than growing without bound.
        if (next.length <= MAX_TABS) return next;
        const evictable = next.findIndex(
          (candidate) => candidate.path !== path && !isDirty(candidate),
        );
        return evictable === -1
          ? next
          : next.filter((_, index) => index !== evictable);
      });
      load(path);
    },
    [load],
  );

  const close = useCallback((path: string): string | null => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.path === path);
    if (index === -1) return activePathRef.current;

    inFlightRead.current.delete(path);
    inFlightWrite.current.delete(path);
    const remaining = current.filter((tab) => tab.path !== path);
    // Updater form, not `setTabs(remaining)`: a read or write that resolved
    // earlier in this same frame has queued a patch that has not rendered yet,
    // and a plain value would discard it — stranding that tab mid-save.
    setTabs((live) => live.filter((tab) => tab.path !== path));

    if (activePathRef.current !== path) return activePathRef.current;
    // Land on the tab that slid into this slot, else the one before it.
    const nextActive = (remaining[index] ?? remaining[index - 1])?.path ?? null;
    setActivePath(nextActive);
    return nextActive;
  }, []);

  const closeOthers = useCallback((path: string): string | null => {
    const kept = tabsRef.current.filter((tab) => tab.path === path);
    for (const tab of tabsRef.current) {
      if (tab.path === path) continue;
      inFlightRead.current.delete(tab.path);
      inFlightWrite.current.delete(tab.path);
    }
    setTabs((live) => live.filter((tab) => tab.path === path));
    setActivePath(kept[0]?.path ?? null);
    return kept[0]?.path ?? null;
  }, []);

  const closeAll = useCallback(() => {
    inFlightRead.current.clear();
    inFlightWrite.current.clear();
    setTabs([]);
    setActivePath(null);
  }, []);

  /**
   * `guard` is the hash the draft was based on, or "force" to write regardless.
   * BB reads an explicit null as create-only, so the guard is either a hash or
   * an absent field — never null.
   */
  const writeActive = useCallback(
    (guard: string | "force") => {
      const activeScope = scopeRef.current;
      const path = activePathRef.current;
      if (activeScope === null || path === null) return;

      const tab = tabsRef.current.find((candidate) => candidate.path === path);
      if (tab === undefined || tab.draft === null) return;
      // A second ⌘S while the first is still in flight would write the same
      // guard hash twice and report the second as a conflict.
      if (tab.save.kind === "saving") return;
      const content = tab.draft;

      const generation = (writeSequence.current += 1);
      inFlightWrite.current.set(path, generation);
      const isCurrent = () =>
        inFlightWrite.current.get(path) === generation &&
        sameScope(scopeRef.current, activeScope);

      patch(path, (current) => ({ ...current, save: { kind: "saving" } }));
      void rpc
        .call("write", {
          scope: activeScope,
          path,
          content,
          ...(guard === "force" ? {} : { expectedSha256: guard }),
        })
        .then((result) => {
          if (!isCurrent()) return;
          if (result.outcome === "conflict") {
            patch(path, (current) => ({ ...current, save: { kind: "conflict" } }));
            return;
          }
          patch(path, (current) => ({
            ...current,
            save: { kind: "clean" },
            sha256: result.sha256,
            // Keep anything typed while the write was in flight; only the text
            // that actually reached disk stops counting as an edit.
            draft: current.draft === content ? null : current.draft,
            file:
              current.file !== null && current.file.kind === "text"
                ? {
                    ...current.file,
                    content,
                    sha256: result.sha256,
                    sizeBytes: result.sizeBytes,
                  }
                : current.file,
          }));
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          patch(path, (current) => ({
            ...current,
            save: { kind: "error", message: messageOf(error, "Save failed") },
          }));
        });
    },
    [patch, rpc],
  );

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;

  return {
    tabs,
    activePath,
    activeTab,
    open,
    close,
    closeOthers,
    closeAll,
    activate: setActivePath,
    setDraft: useCallback(
      (path, draft) => patch(path, (tab) => ({ ...tab, draft })),
      [patch],
    ),
    setMode: useCallback(
      // The toolbar disables what a tab cannot hold, but the rule lives here,
      // so no caller can put a `.ts` tab or an oversized document in Preview.
      (path, mode) =>
        patch(path, (tab) => ({ ...tab, mode: allowedMode(mode, path, renderedText(tab)) })),
      [patch],
    ),
    showSource: useCallback(
      (path) =>
        patch(path, (tab) => (tab.mode === "preview" ? { ...tab, mode: "read" } : tab)),
      [patch],
    ),
    save: useCallback(() => {
      const path = activePathRef.current;
      const tab = tabsRef.current.find((candidate) => candidate.path === path);
      writeActive(tab?.sha256 ?? "force");
    }, [writeActive]),
    overwrite: useCallback(() => {
      writeActive("force");
    }, [writeActive]),
    reload: useCallback(
      (path?: string) => {
        const target = path ?? activePathRef.current;
        if (target === null) return;
        patch(target, (tab) => {
          // Dropping the draft puts the file's own text back in the pane, and
          // that can be over the cap the draft was under. A tab with no text
          // yet — its first read still in flight — has nothing to measure, and
          // `load` settles its mode when the text lands.
          const next: FileTab = { ...tab, draft: null, save: { kind: "clean" } };
          const text = renderedText(next);
          return text === null ? next : { ...next, mode: allowedMode(next.mode, target, text) };
        });
        load(target);
      },
      [load, patch],
    ),
    retry: useCallback(() => {
      const target = activePathRef.current;
      if (target !== null) load(target);
    }, [load]),
    reset: useCallback(() => {
      inFlightRead.current.clear();
      inFlightWrite.current.clear();
      setTabs([]);
      setActivePath(null);
    }, []),
  };
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}
