import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRpc,
  type ExperimentalThreadTabProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
// Statically imported so the explorer's folder/file glyphs paint on the first
// frame instead of flashing empty while the extended registry loads.
import "@/components/ui/icon-extended";
import { formatRoute, parseRoute, sameScope, type ScopeRef } from "@/lib/route";
import type { rpcContract } from "./server.js";
import { Workspace } from "./components/Workspace";

const PANEL_PATH = "files";
const FILES_TAB = {
  id: "files",
  context: { kind: "thread" },
  availability: "action",
} as const;
const LAST_SCOPE_KEY = "files-editor:last-scope";

/**
 * The full-page explorer. The route carries both the workspace and the open
 * file, so back/forward walk the files you opened and a link survives a reload.
 */
function FilesPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const context = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const route = useMemo(() => parseRoute(subPath), [subPath]);

  // With no workspace in the route, fall back to the thread in view, then to
  // whatever was open last, then to the server's first workspace — a visit
  // straight from the sidebar should land on files, not on an empty pane.
  const [fallback, setFallback] = useState<ScopeRef | null>(null);
  useEffect(() => {
    if (route.scope !== null) return;
    let cancelled = false;

    const guess = async (): Promise<ScopeRef | null> => {
      if (context.threadId !== null) return { kind: "thread", id: context.threadId };
      if (context.projectId !== null) return { kind: "project", id: context.projectId };
      const remembered = readLastScope();
      if (remembered !== null) return remembered;
      return (await rpc.call("workspaces")).defaultRef;
    };

    void guess()
      .then((next) => {
        if (cancelled || next === null) return;
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: formatRoute(next, null),
          replace: true,
        });
        setFallback(next);
      })
      .catch(() => {
        if (!cancelled) setFallback(null);
      });

    return () => {
      cancelled = true;
    };
  }, [context.projectId, context.threadId, navigate, route.scope, rpc]);

  const scope = route.scope ?? fallback;

  useEffect(() => {
    if (scope !== null) storeLastScope(scope);
  }, [scope]);

  const onOpenPath = useCallback(
    (path: string | null) => {
      if (scope === null) return;
      // Compare structurally, not against `subPath`: BB hands the subPath back
      // percent-encoded while formatRoute writes raw segments, so a string
      // compare misses for any path with a space, bracket or non-ASCII name and
      // pushes a duplicate history entry every time that tab is clicked.
      if (sameScope(route.scope, scope) && route.filePath === path) return;
      const next = formatRoute(scope, path);
      // Opening a file is navigation the user should be able to undo, so it
      // pushes. Clearing the last tab only rewinds to the workspace root and
      // would otherwise leave a dead entry between two files.
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: next,
        ...(path === null ? { replace: true } : {}),
      });
    },
    [navigate, route.filePath, route.scope, scope],
  );

  const onChangeScope = useCallback(
    (next: ScopeRef) => {
      navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute(next, null) });
    },
    [navigate],
  );

  return (
    <Workspace
      scope={scope}
      filePath={route.filePath}
      onOpenPath={onOpenPath}
      onChangeScope={onChangeScope}
      variant="page"
    />
  );
}

/**
 * The same explorer beside a thread, pinned to that thread's workspace — the
 * files the agent in this conversation is actually editing.
 */
function ThreadFilesPanel({ threadId }: ExperimentalThreadTabProps) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const scope = useMemo<ScopeRef>(
    () => ({ kind: "thread", id: threadId }),
    [threadId],
  );

  return (
    <Workspace
      scope={scope}
      filePath={filePath}
      onOpenPath={setFilePath}
      variant="panel"
    />
  );
}

function readLastScope(): ScopeRef | null {
  try {
    const raw = window.localStorage.getItem(LAST_SCOPE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "kind" in parsed &&
      "id" in parsed &&
      typeof (parsed as ScopeRef).id === "string" &&
      ["thread", "environment", "project"].includes(String((parsed as ScopeRef).kind))
    ) {
      return parsed as ScopeRef;
    }
    return null;
  } catch {
    return null;
  }
}

function storeLastScope(scope: ScopeRef): void {
  try {
    window.localStorage.setItem(LAST_SCOPE_KEY, JSON.stringify(scope));
  } catch {
    // Storage can be unavailable; the next visit just starts from the thread.
  }
}

/**
 * Rendered on the plugin's own page in Tools, beside the declarative settings.
 * BB has no manifest field for a screenshot, so a plugin that wants to show
 * what it looks like has to draw its own section.
 */
function PreviewSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; src: string } | { kind: "error" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("preview")
      .then(({ baseUrl }) => {
        // A confined, expiring host URL for the plugin's own docs directory —
        // no network fetch, and nothing outside that directory is reachable.
        if (!cancelled) setState({ kind: "ready", src: `${baseUrl}/preview.png` });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  // Silent on failure: an image that will not load is not worth an error box
  // on a page whose job is the settings below it.
  if (state.kind !== "ready") return null;

  return (
    <figure className="space-y-2">
      <img
        src={state.src}
        alt="The Files panel: project and worktree pickers over a file tree, tabs, find-in-file, and the open file"
        className="w-full rounded-lg border border-border"
      />
      <figcaption className="text-xs text-muted-foreground">
        An illustration of the layout, not a screenshot.
      </figcaption>
    </figure>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "preview",
    title: "What it looks like",
    description:
      "A searchable tree on the left, tabs across the top, the whole file in the middle.",
    component: PreviewSection,
  });

  app.slots.navPanel({
    id: "files",
    title: "Files",
    icon: "Code",
    path: PANEL_PATH,
    component: FilesPage,
  });

  app.slots.experimental_tab({
    ...FILES_TAB,
    title: "Project files",
    icon: "Code",
    layout: "flush",
    component: ThreadFilesPanel,
    run: ({ experimental_panel }) => {
      experimental_panel.openTab({ tab: FILES_TAB, title: "Files" });
    },
  });

  app.commands.register({
    id: "open-files",
    title: "Files: browse this thread's project",
    // The palette opens anywhere, but this action needs a thread side panel.
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ experimental_panel }) => {
      if (!experimental_panel.openTab({ tab: FILES_TAB, title: "Files" })) {
        toast.error("Open a thread to browse its project files.");
      }
    },
  });
});
