import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn, formatHomePathForDisplay } from "@/lib/utils";
import type { FlatEntry } from "@/lib/tree";
import type { ScopeRef } from "@/lib/route";
import { sameScope } from "@/lib/route";
import { isMarkdownPath } from "@/lib/markdown";
import type { ResolvedScope, rpcContract } from "../server.js";
import { Explorer } from "./Explorer";
import { EditorTabs } from "./EditorTabs";
import { FileView, fileMetaLabel } from "./FileView";
import { QuickOpen } from "./QuickOpen";
import { WorkspacePicker } from "./WorkspacePicker";
import {
  canPreview,
  isDirty,
  useFileTabs,
  type FileTab,
  type FileViewMode,
} from "./use-file-tabs";

interface TreeState {
  status: "idle" | "loading" | "ready" | "error";
  scope: ResolvedScope | null;
  entries: FlatEntry[];
  truncated: boolean;
  listing: "local" | "remote";
  excluded: string[];
  error: string | null;
}

const EMPTY_TREE: TreeState = {
  status: "idle",
  scope: null,
  entries: [],
  truncated: false,
  listing: "local",
  excluded: [],
  error: null,
};

const MIN_EXPLORER_PX = 180;
const MAX_EXPLORER_PX = 560;
const DEFAULT_EXPLORER_PX = 260;

const WIDTH_STORAGE_KEY = "files-editor:explorer-width";
const HIDDEN_STORAGE_KEY = "files-editor:include-hidden";

export interface WorkspaceProps {
  scope: ScopeRef | null;
  filePath: string | null;
  /** Called when the open file changes, so a routed surface can mirror it. */
  onOpenPath: (path: string | null) => void;
  /** Omit to pin the surface to one workspace (the thread panel does). */
  onChangeScope?: (scope: ScopeRef) => void;
  variant: "page" | "panel";
}

export function Workspace({
  scope,
  filePath,
  onOpenPath,
  onChangeScope,
  variant,
}: WorkspaceProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const tabs = useFileTabs(scope);

  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const [includeHidden, setIncludeHidden] = useState(readStoredHidden);
  const [explorerWidth, setExplorerWidth] = useState(readStoredWidth);
  // Both surfaces open on the tree — that is what you came for. The narrow
  // panel then collapses it once you pick a file, to give the editor the width.
  const [isExplorerOpen, setIsExplorerOpen] = useState(true);
  const [isQuickOpen, setIsQuickOpen] = useState(false);
  // A counter, not a flag: pressing ⌘F again with the bar already open has to
  // re-focus and reselect the field, which an unchanged boolean cannot signal.
  const [findRequest, setFindRequest] = useState(0);
  // ⌘⇧F focuses the explorer's text search, VS Code's binding for "search in files".
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  // A search hit to reveal: the file it is in, the line, and a nonce so opening
  // the same hit twice scrolls to it again.
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(
    null,
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);
  // A toast action outlives the render that created it; navigation has to be
  // read live rather than captured.
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  // Closing navigates away, but the route arrives back as a prop a render
  // later. In that gap the route still names the file that was just closed,
  // and the effect below would helpfully reopen it. This remembers the value
  // to ignore until the route catches up.
  const staleRouteFile = useRef<string | null>(null);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  /** Return the keyboard to the surface when a child that held focus is gone. */
  const restoreFocus = useCallback(() => {
    const root = rootRef.current;
    if (root === null) return;
    if (root.contains(document.activeElement)) return;
    root.focus({ preventScroll: true });
  }, []);

  const loadTree = useCallback(
    (target: ScopeRef | null, hidden: boolean) => {
      if (target === null) {
        setTree(EMPTY_TREE);
        return;
      }
      const generation = (requestRef.current += 1);
      setTree((current) => ({ ...current, status: "loading", error: null }));

      void rpc
        .call("tree", { scope: target, includeHidden: hidden })
        .then((result) => {
          if (requestRef.current !== generation) return;
          setTree({
            status: "ready",
            scope: result.scope,
            entries: result.entries,
            truncated: result.truncated,
            listing: result.listing,
            excluded: result.excluded,
            error: null,
          });
        })
        .catch((error: unknown) => {
          if (requestRef.current !== generation) return;
          setTree({
            ...EMPTY_TREE,
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Could not read this workspace.",
          });
        });
    },
    [rpc],
  );

  // Keyed on the scope's VALUE, not the object: callers build the ref during
  // render, so a fresh identity every render would re-walk the whole workspace
  // on every keystroke and every file click.
  const scopeKind = scope?.kind ?? null;
  const scopeId = scope?.id ?? null;
  useEffect(() => {
    loadTree(
      scopeKind === null || scopeId === null ? null : { kind: scopeKind, id: scopeId },
      includeHidden,
    );
  }, [includeHidden, loadTree, scopeId, scopeKind]);

  // Open the file named by the route: on arrival, when the route moves to
  // another file, and after a scope change cleared the tabs out from under it.
  const hasRoutedTab = tabs.tabs.some((tab) => tab.path === filePath);
  useEffect(() => {
    if (staleRouteFile.current !== null) {
      if (filePath === staleRouteFile.current) return;
      staleRouteFile.current = null;
    }
    if (filePath === null) return;
    if (tabs.activePath === filePath || hasRoutedTab) return;
    tabs.open(filePath);
    // `tabs` is rebuilt every render; the open is keyed on the route value and
    // on whether this surface already holds that file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, hasRoutedTab, scopeId, scopeKind]);

  useRealtime("files-editor/changed", (payload) => {
    const change = payload as { scope?: ScopeRef; path?: string; sha256?: string };
    if (typeof change.path !== "string") return;
    if (!sameScope(change.scope ?? null, scope)) return;
    const tab = tabs.tabs.find((candidate) => candidate.path === change.path);
    if (tab === undefined || isDirty(tab)) return;
    if (tab.sha256 === change.sha256) return;
    tabs.reload(change.path);
  });

  const openFile = useCallback(
    (path: string) => {
      staleRouteFile.current = null;
      setReveal(null);
      tabs.open(path);
      onOpenPath(path);
      setFindRequest(0);
      // The explorer deliberately stays open: it used to collapse itself on the
      // narrow panel to give the editor width, which meant the tree vanished
      // under you every time you opened a file. Closing it is the toggle's job.
      //
      // The element that held focus is routinely the one the open destroys —
      // the empty state's button, or the previous file's textarea. Recover it,
      // or the root's ⌘P / ⌘S handlers stop receiving keys.
      requestAnimationFrame(restoreFocus);
    },
    [onOpenPath, restoreFocus, tabs],
  );

  // A ref, not derived from the previous state: openFile resets the reveal to
  // null in the same batch, so an updater would always see null and every hit
  // would get the same nonce — and clicking one twice would not scroll again.
  const revealNonce = useRef(0);
  const openMatch = useCallback(
    (path: string, line: number) => {
      openFile(path);
      // A markdown tab opens in Preview, which renders the document and has no
      // lines to scroll to. A search hit names a line, so show the source —
      // the same reason ⌘F flips a preview tab to Read.
      tabs.showSource(path);
      revealNonce.current += 1;
      setReveal({ path, line, nonce: revealNonce.current });
    },
    [openFile, tabs],
  );

  const closeTab = useCallback(
    (path: string) => {
      staleRouteFile.current = filePath;
      const tab = tabs.tabs.find((candidate) => candidate.path === path);
      if (tab !== undefined && isDirty(tab)) {
        toast.warning(`${path} has unsaved changes`, {
          action: {
            label: "Close anyway",
            // Through the ref: the action can be clicked many renders later,
            // and the captured `onOpenPath` would navigate using the route as
            // it was when the X was clicked, not as it is now.
            onClick: () => onOpenPathRef.current(tabs.close(path)),
          },
        });
        return;
      }
      onOpenPath(tabs.close(path));
    },
    [filePath, onOpenPath, tabs],
  );

  /** Shared by "close others" and "close all": both can discard several drafts. */
  const closeMany = useCallback(
    (doomed: readonly FileTab[], run: () => string | null) => {
      staleRouteFile.current = filePath;
      const dirtyCount = doomed.filter(isDirty).length;
      if (dirtyCount > 0) {
        toast.warning(
          dirtyCount === 1
            ? "1 file has unsaved changes"
            : `${dirtyCount} files have unsaved changes`,
          {
            action: {
              label: "Close anyway",
              onClick: () => onOpenPathRef.current(run()),
            },
          },
        );
        return;
      }
      onOpenPath(run());
    },
    [filePath, onOpenPath],
  );

  const closeOtherTabs = useCallback(
    (path: string) => {
      closeMany(
        tabs.tabs.filter((tab) => tab.path !== path),
        () => tabs.closeOthers(path),
      );
    },
    [closeMany, tabs],
  );

  const closeAllTabs = useCallback(() => {
    closeMany(tabs.tabs, () => {
      tabs.closeAll();
      return null;
    });
  }, [closeMany, tabs]);

  const activateTab = useCallback(
    (path: string) => {
      tabs.activate(path);
      onOpenPath(path);
    },
    [onOpenPath, tabs],
  );

  const activeTab = tabs.activeTab;
  const resolved = tree.scope;

  // Find searches the file's text, and reveals a hit by highlighting its line
  // in the source viewer — the rendered pane has no lines and its text is not
  // the text being searched. So opening find on a preview tab first shows it
  // the source it is about to search.
  const openFind = () => {
    if (activeTab === null) return;
    tabs.showSource(activeTab.path);
    setFindRequest((current) => current + 1);
  };

  // Find has no bar over a rendered pane, so a tab that enters Preview — from
  // the segment, by activating it, or by closing the tab in front of it — ends
  // the find session rather than hiding it. Set during render, not in an
  // effect, so the pane never draws a bar for the frame in between.
  if (findRequest > 0 && activeTab?.mode === "preview") setFindRequest(0);
  const isFindShowing = findRequest > 0;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const isAccel = event.metaKey || event.ctrlKey;
    if (isAccel && event.key.toLowerCase() === "p" && !event.shiftKey) {
      event.preventDefault();
      setIsQuickOpen(true);
      return;
    }
    if (isAccel && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setIsExplorerOpen(true);
      setSearchFocusRequest((current) => current + 1);
      return;
    }
    if (isAccel && event.key.toLowerCase() === "f" && !event.shiftKey) {
      // Claims the browser's own find, which cannot see a virtualized tree or
      // the textarea's unrendered lines anyway.
      event.preventDefault();
      if (activeTab?.file?.kind === "text") openFind();
      return;
    }
    if (isAccel && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (
        activeTab !== null &&
        isDirty(activeTab) &&
        activeTab.save.kind !== "saving"
      ) {
        tabs.save();
      }
      return;
    }
    if (event.key === "Escape" && isQuickOpen) {
      event.preventDefault();
      setIsQuickOpen(false);
      return;
    }
    if (event.key === "Escape" && isFindShowing) {
      event.preventDefault();
      setFindRequest(0);
    }
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      setExplorerWidth(clampWidth(startWidth + moveEvent.clientX - startX));
    };
    const stop = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      setExplorerWidth((width) => {
        storeWidth(width);
        return width;
      });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
  };

  const explorerHeader = useMemo(
    () => (
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1.5">
        {onChangeScope === undefined ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-xs">
            <Icon
              name={resolved?.environmentId === null ? "Folder" : "GitBranch"}
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate font-medium text-foreground">
              {resolved?.label ?? "Workspace"}
            </span>
            <span className="truncate text-muted-foreground">
              {resolved?.sublabel ?? ""}
            </span>
          </div>
        ) : (
          <WorkspacePicker
            current={resolved}
            onSelect={(next) => {
              onChangeScope(next);
              setIsQuickOpen(false);
            }}
          />
        )}
      </div>
    ),
    [onChangeScope, resolved],
  );

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      // Focusable and focused on mount so ⌘P and ⌘S work before anything inside
      // has been clicked, and again after a child that had focus unmounts.
      tabIndex={-1}
      // `h-full` as well as `flex-1`: flex-1 only sizes this when the host
      // hands the surface a flex column. A thread panel tab is a definite-height
      // box, where flex-1 does nothing, the root takes its content's height, and
      // nothing inside it — the tree least of all — can ever scroll.
      className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background focus:outline-none"
    >
      {isExplorerOpen ? (
        <>
          <div
            style={{ width: explorerWidth }}
            className="flex min-h-0 shrink-0 flex-col overflow-hidden"
          >
            <Explorer
              entries={tree.entries}
              activePath={tabs.activePath}
              isLoading={tree.status === "loading"}
              error={tree.error}
              truncated={tree.truncated}
              hiddenSupported={tree.listing === "local"}
              includeHidden={includeHidden}
              onToggleHidden={(next) => {
                setIncludeHidden(next);
                storeHidden(next);
              }}
              onOpenFile={openFile}
              onOpenMatch={openMatch}
              onRefresh={() => loadTree(scope, includeHidden)}
              onQuickOpen={() => setIsQuickOpen(true)}
              scope={scope}
              searchFocusRequest={searchFocusRequest}
              header={explorerHeader}
            />
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the file explorer"
            onPointerDown={startResize}
            onDoubleClick={() => {
              setExplorerWidth(DEFAULT_EXPLORER_PX);
              storeWidth(DEFAULT_EXPLORER_PX);
            }}
            className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-ring"
          />
        </>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EditorTabs
          tabs={tabs.tabs}
          activePath={tabs.activePath}
          onActivate={activateTab}
          onClose={closeTab}
          onCloseOthers={closeOtherTabs}
          onCloseAll={closeAllTabs}
        />

        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
          <button
            type="button"
            onClick={() => setIsExplorerOpen((open) => !open)}
            aria-label={isExplorerOpen ? "Hide the file explorer" : "Show the file explorer"}
            title={isExplorerOpen ? "Hide the file explorer" : "Show the file explorer"}
            className={cn(
              "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md",
              "text-muted-foreground hover:bg-state-hover hover:text-foreground",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              isExplorerOpen && "text-foreground",
            )}
          >
            <Icon name="PanelLeft" aria-hidden className="size-3.5" />
          </button>

          <Breadcrumb
            root={resolved?.root ?? null}
            path={activeTab?.path ?? null}
            hostName={resolved?.hostName ?? null}
            isLocal={resolved?.isLocal ?? true}
          />

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {activeTab?.file?.kind === "text" ? (
              <>
                <span className="hidden px-2 text-[11px] text-muted-foreground md:inline">
                  {fileMetaLabel(activeTab)}
                </span>
                <ModeToggle
                  mode={activeTab.mode}
                  isMarkdown={isMarkdownPath(activeTab.path)}
                  canPreview={canPreview(activeTab)}
                  canEdit={activeTab.file.editable}
                  onChange={(next) => tabs.setMode(activeTab.path, next)}
                />
                <ToolbarButton
                  icon="Search"
                  label="Find in file (⌘F)"
                  isActive={isFindShowing}
                  onClick={() =>
                    isFindShowing ? setFindRequest(0) : openFind()
                  }
                />
                <ToolbarButton
                  icon="Check"
                  label={
                    activeTab.save.kind === "saving"
                      ? "Saving…"
                      : "Save (⌘S)"
                  }
                  isDisabled={!isDirty(activeTab) || activeTab.save.kind === "saving"}
                  isSpinning={activeTab.save.kind === "saving"}
                  onClick={tabs.save}
                />
              </>
            ) : null}
            {activeTab !== null && resolved !== null ? (
              <ToolbarButton
                icon="ExternalLink"
                label="Open in BB's file preview"
                onClick={() => {
                  const opened = navigate.experimental_openFilePreview({
                    target:
                      resolved.environmentId === null
                        ? {
                            kind: "host",
                            hostId: resolved.hostId,
                            path: absolutePathFor(resolved.root, activeTab.path),
                          }
                        : {
                            kind: "workspace",
                            environmentId: resolved.environmentId,
                            path: activeTab.path,
                          },
                    location: null,
                  });
                  if (!opened) {
                    toast.error("This surface has no file preview panel.");
                  }
                }}
              />
            ) : null}
          </div>
        </div>

        {activeTab === null ? (
          <EmptyEditor
            hasWorkspace={resolved !== null}
            error={tree.error}
            listing={tree.listing}
            truncated={tree.truncated}
            excluded={tree.excluded}
            onQuickOpen={() => setIsQuickOpen(true)}
          />
        ) : (
          <FileView
            tab={activeTab}
            onChangeDraft={tabs.setDraft}
            onSave={tabs.save}
            onReload={() => tabs.reload()}
            onOverwrite={tabs.overwrite}
            onRetry={tabs.retry}
            revealLine={
              reveal !== null && reveal.path === activeTab.path
                ? { line: reveal.line, nonce: reveal.nonce }
                : null
            }
            findRequest={findRequest}
            onCloseFind={() => {
              setFindRequest(0);
              restoreFocus();
            }}
          />
        )}
      </div>

      {isQuickOpen ? (
        <QuickOpen
          entries={tree.entries}
          onOpenFile={openFile}
          onClose={() => setIsQuickOpen(false)}
        />
      ) : null}
    </div>
  );
}

function Breadcrumb({
  root,
  path,
  hostName,
  isLocal,
}: {
  root: string | null;
  path: string | null;
  hostName: string | null;
  isLocal: boolean;
}) {
  if (root === null) {
    return <span className="truncate text-xs text-muted-foreground">No workspace</span>;
  }
  const segments = path === null ? [] : path.split("/");
  const rootLabel = formatHomePathForDisplay(root).split(/[/\\]/).filter(Boolean).at(-1) ?? root;

  return (
    <nav
      aria-label="File location"
      title={path === null ? root : `${root}/${path}`}
      className="flex min-w-0 items-center gap-1 overflow-hidden text-xs"
    >
      {isLocal ? null : (
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <Icon name="Laptop" aria-hidden className="size-3" />
          {hostName}
          <Icon name="ChevronRight" aria-hidden className="size-3" />
        </span>
      )}
      <span className="shrink-0 text-muted-foreground">{rootLabel}</span>
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
          <Icon
            name="ChevronRight"
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground"
          />
          <span
            className={cn(
              "truncate",
              index === segments.length - 1
                ? "text-foreground"
                : "text-muted-foreground",
            )}
          >
            {segment}
          </span>
        </span>
      ))}
    </nav>
  );
}

function EmptyEditor({
  hasWorkspace,
  error,
  listing,
  truncated,
  excluded,
  onQuickOpen,
}: {
  hasWorkspace: boolean;
  error: string | null;
  listing: "local" | "remote";
  truncated: boolean;
  excluded: readonly string[];
  onQuickOpen: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Icon name="Code" aria-hidden className="size-8 text-muted-foreground/60" />
      {error !== null ? (
        <p className="max-w-sm text-sm text-destructive-text">{error}</p>
      ) : !hasWorkspace ? (
        <p className="max-w-sm text-sm text-muted-foreground">
          Pick a workspace to browse its files.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Select a file to open it, or{" "}
            <button
              type="button"
              onClick={onQuickOpen}
              className="cursor-pointer font-medium text-foreground underline underline-offset-2"
            >
              go to file
            </button>
            .
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            {listing === "remote"
              ? "This workspace is on another machine, so BB lists it — dotfiles are not included."
              : excluded.length === 0
                ? "Every file in the workspace is listed."
                : `Excluding ${excluded.join(", ")}.`}
            {truncated ? " The listing hit its size limit." : ""}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Preview / Read / Edit as labelled segments rather than one icon that swaps
 * meaning. An icon-only toggle has to be read twice — once for the glyph, once
 * to work out whether it shows the current mode or the one it switches to.
 */
function ModeToggle({
  mode,
  isMarkdown,
  canPreview,
  canEdit,
  onChange,
}: {
  mode: FileViewMode;
  /** Only markdown has a rendered form; every other file gets two segments. */
  isMarkdown: boolean;
  canPreview: boolean;
  canEdit: boolean;
  onChange: (mode: FileViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="File mode"
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {isMarkdown ? (
        <ModeSegment
          icon="FileText"
          label="Preview"
          isSelected={mode === "preview"}
          // Rendering is one synchronous pass over the whole document, so a
          // huge one would freeze the surface; the segment says why it is off.
          isDisabled={!canPreview}
          title={canPreview ? undefined : "This file is too large to preview"}
          onClick={() => onChange("preview")}
        />
      ) : null}
      <ModeSegment
        icon="Eye"
        label="Read"
        isSelected={mode === "read"}
        onClick={() => onChange("read")}
      />
      <ModeSegment
        icon="Edit"
        label="Edit"
        isSelected={mode === "edit"}
        // A file too large to edit stays readable; the segment says why.
        isDisabled={!canEdit && mode !== "edit"}
        title={canEdit ? undefined : "This file is too large to edit"}
        onClick={() => onChange("edit")}
      />
    </div>
  );
}

function ModeSegment({
  icon,
  label,
  isSelected,
  isDisabled,
  title,
  onClick,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  isSelected: boolean;
  isDisabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-pressed={isSelected}
      title={title ?? label}
      className={cn(
        "flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium transition-colors",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isDisabled === true
          ? "cursor-default text-muted-foreground opacity-40"
          : isSelected
            ? "cursor-pointer bg-state-active text-foreground"
            : "cursor-pointer text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon name={icon} aria-hidden className="size-3" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  isActive,
  isDisabled,
  isSpinning,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  onClick: () => void;
  isActive?: boolean;
  isDisabled?: boolean;
  isSpinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md",
        "text-muted-foreground transition-colors",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isDisabled === true
          ? "cursor-default opacity-40"
          : "cursor-pointer hover:bg-state-hover hover:text-foreground",
        isActive === true && "text-foreground",
      )}
    >
      <Icon
        name={icon}
        aria-hidden
        className={cn("size-3.5", isSpinning === true && "animate-spin")}
      />
    </button>
  );
}

function absolutePathFor(root: string, relativePath: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const trimmed = root.endsWith(separator) ? root.slice(0, -1) : root;
  const tail =
    separator === "\\" ? relativePath.replace(/\//g, "\\") : relativePath;
  return `${trimmed}${separator}${tail}`;
}

function clampWidth(value: number): number {
  return Math.min(MAX_EXPLORER_PX, Math.max(MIN_EXPLORER_PX, Math.round(value)));
}

function readStoredWidth(): number {
  const stored = safeRead(WIDTH_STORAGE_KEY);
  const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
  return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_EXPLORER_PX;
}

function storeWidth(value: number): void {
  safeWrite(WIDTH_STORAGE_KEY, String(value));
}

function readStoredHidden(): boolean {
  return safeRead(HIDDEN_STORAGE_KEY) !== "false";
}

function storeHidden(value: boolean): void {
  safeWrite(HIDDEN_STORAGE_KEY, value ? "true" : "false");
}

function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, embedded webview); the
    // preference simply does not persist.
  }
}
