import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { basename, dirname } from "@/lib/tree";
import type { ScopeRef } from "@/lib/route";
import type { SearchResult, rpcContract } from "../server.js";
import { FileGlyph } from "./FileGlyph";

/** Long enough to skip the keystrokes of a word being typed, short enough to feel live. */
const DEBOUNCE_MS = 180;

export interface SearchResultsProps {
  scope: ScopeRef;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  includeHidden: boolean;
  /** Bumped by Enter in the field: search now, without waiting out the debounce. */
  submitNonce: number;
  activePath: string | null;
  onOpenMatch: (path: string, line: number) => void;
}

/**
 * Text search across the whole workspace, grouped by file. Results from a
 * superseded query are dropped here; the server also abandons the work.
 */
export function SearchResults({
  scope,
  query,
  matchCase,
  wholeWord,
  regex,
  includeHidden,
  submitNonce,
  activePath,
  onOpenMatch,
}: SearchResultsProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<SearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0);
  const lastSubmit = useRef(submitNonce);

  const scopeKind = scope.kind;
  const scopeId = scope.id;

  useEffect(() => {
    const request = (generation.current += 1);
    const immediate = submitNonce !== lastSubmit.current;
    lastSubmit.current = submitNonce;
    setIsSearching(true);

    const timer = window.setTimeout(
      () => {
        void rpc
          .call("searchText", {
            scope: { kind: scopeKind, id: scopeId },
            query,
            matchCase,
            wholeWord,
            regex,
            includeHidden,
          })
          .then((next) => {
            if (request !== generation.current) return;
            // A cancelled search was replaced by a newer one; that one answers.
            if (next.status === "cancelled") return;
            setResult(next);
            setIsSearching(false);
            setCollapsed(new Set());
          })
          .catch((error: unknown) => {
            if (request !== generation.current) return;
            setResult({
              status: "error",
              message: error instanceof Error ? error.message : "Search failed.",
            });
            setIsSearching(false);
          });
      },
      immediate ? 0 : DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [includeHidden, matchCase, query, regex, rpc, scopeId, scopeKind, submitNonce, wholeWord]);

  const files = result?.status === "ok" ? result.files : [];
  const allCollapsed = files.length > 0 && files.every((file) => collapsed.has(file.path));

  const toggleFile = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" role="status" aria-label="Search summary">
          <Summary result={result} isSearching={isSearching} />
        </span>
        {isSearching ? (
          <Icon name="Loading" aria-hidden className="size-3 shrink-0 animate-spin" />
        ) : null}
        {files.length > 1 ? (
          <button
            type="button"
            onClick={() =>
              setCollapsed(allCollapsed ? new Set() : new Set(files.map((file) => file.path)))
            }
            className="shrink-0 cursor-pointer rounded px-1 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        ) : null}
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto pb-2 transition-opacity",
          // Keep the previous answer on screen while the next is on its way,
          // rather than flashing empty on every keystroke.
          isSearching && result !== null && "opacity-60",
        )}
      >
        {result?.status === "error" ? (
          <p className="px-3 py-1 text-xs text-destructive">{result.message}</p>
        ) : result?.status === "ok" && files.length === 0 && !isSearching ? (
          <p className="px-3 py-1 text-xs text-muted-foreground">
            No results for “{query}”.
          </p>
        ) : (
          // Rows fit the sidebar and ellipsize, rather than making the whole
          // results list scroll sideways for the one long line in it.
          <ul aria-label="Search results">
            {files.map((file) => (
              <FileGroup
                key={file.path}
                file={file}
                isCollapsed={collapsed.has(file.path)}
                isActive={file.path === activePath}
                onToggle={() => toggleFile(file.path)}
                onOpenMatch={onOpenMatch}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Summary({
  result,
  isSearching,
}: {
  result: SearchResult | null;
  isSearching: boolean;
}) {
  if (result === null) return <>{isSearching ? "Searching…" : ""}</>;
  if (result.status !== "ok") return null;

  const matches = `${result.totalMatches.toLocaleString()} ${result.totalMatches === 1 ? "result" : "results"}`;
  const files = `${result.files.length.toLocaleString()} ${result.files.length === 1 ? "file" : "files"}`;
  const cut =
    result.reason === "matches" || result.reason === "files"
      ? " · refine to see the rest"
      : result.reason === "time"
        ? " · stopped after 10 s"
        : result.reason === "listing"
          ? " · not every file was searched"
          : "";
  const remote = result.listing === "remote" ? " · dotfiles not searched on a connected machine" : "";
  return (
    <>
      {matches} in {files}
      {cut}
      {remote}
    </>
  );
}

function FileGroup({
  file,
  isCollapsed,
  isActive,
  onToggle,
  onOpenMatch,
}: {
  file: Extract<SearchResult, { status: "ok" }>["files"][number];
  isCollapsed: boolean;
  isActive: boolean;
  onToggle: () => void;
  onOpenMatch: (path: string, line: number) => void;
}) {
  const directory = dirname(file.path);
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        title={file.path}
        className={cn(
          "flex h-6 w-full cursor-pointer items-center gap-1.5 pr-3 pl-2 text-left text-[13px]",
          "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-1",
          isActive && "bg-surface-selected",
        )}
      >
        <Icon
          name={isCollapsed ? "ChevronRight" : "ChevronDown"}
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground"
        />
        <FileGlyph path={file.path} kind="file" />
        {/* The name stays whole and the folder gives way first — the name is
            what you are scanning for. */}
        <span className="max-w-full shrink-0 truncate font-medium text-foreground">
          {basename(file.path)}
        </span>
        {directory !== "" ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {directory}
          </span>
        ) : null}
        <span className="shrink-0 rounded-full bg-state-active px-1.5 text-[10px] tabular-nums text-muted-foreground">
          {file.matchCount}
        </span>
      </button>
      {isCollapsed ? null : (
        <ul>
          {file.matches.map((match) => (
            <li key={match.line}>
              <button
                type="button"
                onClick={() => onOpenMatch(file.path, match.line)}
                title={`${file.path}:${match.line}`}
                className={cn(
                  "flex h-6 w-full cursor-pointer items-center gap-2 pr-3 pl-8 text-left",
                  "font-mono text-[12px] text-foreground/85 hover:bg-state-hover",
                  "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-1",
                )}
              >
                <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {match.line}
                </span>
                <span className="min-w-0 flex-1 truncate whitespace-pre">
                  <Preview match={match} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Preview({
  match,
}: {
  match: Extract<SearchResult, { status: "ok" }>["files"][number]["matches"][number];
}) {
  const parts = useMemo(() => {
    const out: Array<{ text: string; hit: boolean }> = [];
    let cursor = 0;
    for (const [start, end] of match.ranges) {
      if (start > cursor) out.push({ text: match.preview.slice(cursor, start), hit: false });
      out.push({ text: match.preview.slice(start, end), hit: true });
      cursor = end;
    }
    if (cursor < match.preview.length) out.push({ text: match.preview.slice(cursor), hit: false });
    return out;
  }, [match]);

  return (
    <>
      {match.clippedStart ? <span className="text-muted-foreground">…</span> : null}
      {parts.map((part, index) =>
        part.hit ? (
          // eslint-disable-next-line react/no-array-index-key -- position IS the part's identity
          <mark key={index} className="rounded-[2px] bg-primary/25 text-foreground">
            {part.text}
          </mark>
        ) : (
          // eslint-disable-next-line react/no-array-index-key -- same
          <span key={index}>{part.text}</span>
        ),
      )}
      {match.clippedEnd ? <span className="text-muted-foreground">…</span> : null}
    </>
  );
}
