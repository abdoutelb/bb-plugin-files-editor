import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  experimental_SourceCode as SourceCode,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatBytes, languageLabel } from "@/lib/file-kind";
import { findMatches, matchIndexAt, stepMatch } from "@/lib/find";
import { FindBar } from "./FindBar";
import type { FileTab } from "./use-file-tabs";

export interface FileViewProps {
  tab: FileTab;
  onChangeDraft: (path: string, draft: string) => void;
  onSave: () => void;
  onReload: () => void;
  onOverwrite: () => void;
  onRetry: () => void;
  /**
   * Bumped by the surface when ⌘F is pressed. A nonce rather than a boolean so
   * a repeat press with the bar already open re-focuses and reselects it.
   */
  findRequest: number;
  onCloseFind: () => void;
}

/** A range to select in the editor; `nonce` re-applies an unchanged range. */
interface EditorSelection {
  start: number;
  end: number;
  nonce: number;
}

export function FileView({
  tab,
  onChangeDraft,
  onSave,
  onReload,
  onOverwrite,
  onRetry,
  findRequest,
  onCloseFind,
}: FileViewProps) {
  const file = tab.file;

  if (file === null) {
    return tab.error === null ? (
      <Centered>
        <Icon name="Loading" aria-hidden className="size-4 animate-spin" />
        <span>Opening {tab.path}…</span>
      </Centered>
    ) : (
      <Centered tone="error">
        <Icon name="AlertTriangle" aria-hidden className="size-4" />
        <span>{tab.error}</span>
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer font-medium underline underline-offset-2"
        >
          Try again
        </button>
      </Centered>
    );
  }

  if (file.kind === "image") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
        <img
          src={file.dataUrl}
          alt={tab.path}
          className="mx-auto max-w-full rounded-md border border-border bg-card object-contain"
        />
        <p className="mt-3 text-center text-xs text-muted-foreground">
          {formatBytes(file.sizeBytes)}
        </p>
      </div>
    );
  }

  if (file.kind === "binary") {
    return (
      <Centered>
        <Icon name="File" aria-hidden className="size-4" />
        <span>
          {file.reason} ({formatBytes(file.sizeBytes)})
        </span>
      </Centered>
    );
  }

  return (
    <TextFileView
      tab={tab}
      content={tab.draft ?? file.content}
      onChangeDraft={onChangeDraft}
      onSave={onSave}
      onReload={onReload}
      onOverwrite={onOverwrite}
      findRequest={findRequest}
      onCloseFind={onCloseFind}
    />
  );
}

/**
 * The text branch, split out so find state can use hooks: the cases above it
 * (loading, error, image, binary) return early, and a hook cannot sit behind
 * a conditional return.
 */
function TextFileView({
  tab,
  content,
  onChangeDraft,
  onSave,
  onReload,
  onOverwrite,
  findRequest,
  onCloseFind,
}: {
  tab: FileTab;
  content: string;
  onChangeDraft: (path: string, draft: string) => void;
  onSave: () => void;
  onReload: () => void;
  onOverwrite: () => void;
  findRequest: number;
  onCloseFind: () => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [index, setIndex] = useState(-1);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const caretRef = useRef(0);
  const nonceRef = useRef(0);

  // Find reads the file's text: its offsets index the markdown source, and it
  // reveals a hit through the source viewer's line highlight. The rendered pane
  // has neither, so the bar would count matches it cannot show. ⌘F switches a
  // preview tab to Read; this covers the other way in — switching to a preview
  // tab while the bar is already open.
  const isFindOpen = findRequest > 0 && tab.mode !== "preview";

  // Each file gets its own find session. Without this, switching tabs would
  // leave the previous file's query counting matches in the new one.
  useEffect(() => {
    setQuery("");
    setIndex(-1);
    setSelection(null);
    caretRef.current = 0;
  }, [tab.path]);

  const result = useMemo(
    () => (isFindOpen ? findMatches(content, query, caseSensitive) : null),
    [caseSensitive, content, isFindOpen, query],
  );
  const matches = result?.matches ?? [];

  const select = useCallback(
    (next: number) => {
      setIndex(next);
      const match = matches[next];
      if (match === undefined) return;
      caretRef.current = match.start;
      nonceRef.current += 1;
      setSelection({ start: match.start, end: match.end, nonce: nonceRef.current });
    },
    [matches],
  );

  // Editing the query restarts the search from where the caret already is,
  // rather than jumping to the top of the file on every keystroke.
  useEffect(() => {
    if (!isFindOpen) return;
    setIndex(matchIndexAt(matches, caretRef.current));
    // `matches` is derived from the query, case flag and content; re-running on
    // the derived value would loop through the setIndex above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, content, isFindOpen]);

  const step = useCallback(
    (direction: 1 | -1) => select(stepMatch(index, matches.length, direction)),
    [index, matches.length, select],
  );

  const active = matches[index];

  // SourceCode owns its scrollport, and it comes up scrolled to the END of the
  // file — so a freshly opened file showed its last line and would not scroll
  // down, because it was already there.
  //
  // One reset is not enough: the viewer settles its position after the content
  // has been measured and highlighted, which is several frames out and not
  // observable from here. So hold the top while the content is still growing,
  // and let go the moment the reader touches it.
  const viewRef = useRef<HTMLDivElement | null>(null);
  const seenPathRef = useRef<string | null>(null);
  useEffect(() => {
    // Recorded before the mode check, so a tab that spent its first renders in
    // preview still counts as seen once it flips to read.
    const isSameFile = seenPathRef.current === tab.path;
    seenPathRef.current = tab.path;
    // Only the read branch mounts the viewer this reaches for. In preview the
    // query below would find nothing and reschedule itself every frame for as
    // long as the tab stays open.
    if (tab.mode !== "read") return;
    // Flipping THIS file to read with a hit already selected is what ⌘F on a
    // preview tab produces: the reveal and the pin land in the same commit, and
    // the top, re-pinned on every resize for the next 1500ms, would win.
    // Whoever asked for the hit asked for the scroll. Another file is a
    // different matter — the previous tab's query survives into its first
    // render, and a hit belonging to a file the reader just left must not cost
    // this one the top it is supposed to open at.
    if (isSameFile && active !== undefined) return;
    const root = viewRef.current;
    if (root === null) return;

    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let timer = 0;
    let frame = 0;

    const attach = () => {
      if (cancelled) return;
      const port = root.querySelector<HTMLElement>('[class*="overflow-y-auto"]');
      if (port === null) {
        frame = requestAnimationFrame(attach);
        return;
      }
      port.scrollTop = 0;

      const release = () => {
        observer?.disconnect();
        observer = null;
        window.clearTimeout(timer);
        port.removeEventListener("wheel", release);
        port.removeEventListener("pointerdown", release);
        port.removeEventListener("keydown", release);
      };
      port.addEventListener("wheel", release, { passive: true });
      port.addEventListener("pointerdown", release);
      port.addEventListener("keydown", release);

      observer = new ResizeObserver(() => {
        port.scrollTop = 0;
      });
      const content = port.firstElementChild;
      if (content !== null) observer.observe(content);
      // A backstop, in case the content never resizes and nothing is touched.
      timer = window.setTimeout(release, 1500);
    };

    attach();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      observer?.disconnect();
    };
    // `active` is read but not depended on: stepping to the next hit must not
    // re-run this and pin a file the reader is already moving around in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.path, tab.mode]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isFindOpen ? (
        <FindBar
          query={query}
          onQueryChange={setQuery}
          caseSensitive={caseSensitive}
          onCaseSensitiveChange={setCaseSensitive}
          index={index}
          total={matches.length}
          truncated={result?.truncated ?? false}
          onStep={step}
          onClose={onCloseFind}
          focusRequest={findRequest}
        />
      ) : null}
      <SaveNotice tab={tab} onReload={onReload} onOverwrite={onOverwrite} />
      {tab.mode === "edit" ? (
        <CodeEditor
          path={tab.path}
          value={content}
          onChange={(next) => onChangeDraft(tab.path, next)}
          onSave={onSave}
          selection={selection}
          onCaretChange={(position) => {
            caretRef.current = position;
          }}
        />
      ) : tab.mode === "preview" ? (
        // The mirror image of the branch below. Markdown's root is a plain
        // block that grows to its content and owns no scrolling at all, so the
        // scrollport has to come from here, or the pane is simply clipped at
        // the first screen. The inner div is only a measure: prose run to the
        // full width of a widescreen panel is unreadable, and the host styles
        // everything within it.
        //
        // `content` is the draft where there is one — flipping to Preview
        // mid-edit has to show what the tab's dirty dot is promising.
        // Keyed: this div is the scrollport, and React would otherwise reuse
        // the node across a tab switch, opening the next document at the
        // scroll offset of the last one.
        <div key={tab.path} className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[52rem] p-5">
            <Markdown content={content} />
          </div>
        </div>
      ) : (
        // Deliberately NOT wrapped in a scroll container. SourceCode's own root
        // is `flex-1 overflow-y-auto` — it means to be the scrollport. Wrapping
        // it let it expand to full content height, so it never scrolled and its
        // scroll-into-view had nothing to move, which is what broke the find
        // reveal. Bounded by this column, it scrolls natively.
        // A plain wrapper, deliberately with no overflow of its own: it exists
        // to reach SourceCode's scrollport, not to become a second one.
        <div ref={viewRef} className="flex min-h-0 flex-1 flex-col">
        <SourceCode
          content={content}
          path={tab.path}
          overflow="scroll"
          // The host viewer owns scroll-into-view, so highlighting the line is
          // also what reveals it.
          highlightedLines={
            active === undefined
              ? null
              : { start: active.line, end: active.line }
          }
          className="min-h-0 flex-1 text-[13px]"
        />
        </div>
      )}
    </div>
  );
}

/**
 * A plain textarea with a matching gutter. BB's own source viewer owns
 * highlighting for reading; editing only needs a caret, a monospace grid, and
 * line numbers that stay glued to it while it scrolls.
 */
function CodeEditor({
  path,
  value,
  onChange,
  onSave,
  selection,
  onCaretChange,
}: {
  path: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  selection: EditorSelection | null;
  onCaretChange: (position: number) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLPreElement | null>(null);

  const lineCount = useMemo(() => value.split("\n").length, [value]);
  // One text node rather than one element per line: a 100k-line lock file would
  // otherwise remount its whole gutter on every keystroke.
  const gutterText = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount],
  );

  useEffect(() => {
    textareaRef.current?.focus();
  }, [path]);

  // Reveal a find hit: select it, then scroll the caret's line to the middle.
  // `selectionStart` alone does not scroll a textarea, and blur/refocus would
  // steal the keyboard back from the find field.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null || selection === null) return;
    textarea.setSelectionRange(selection.start, selection.end);

    const lineHeight = 20;
    const linesAbove = value.slice(0, selection.start).split("\n").length - 1;
    const target =
      linesAbove * lineHeight - textarea.clientHeight / 2 + lineHeight;
    textarea.scrollTop = Math.max(0, target);
    if (gutterRef.current !== null) {
      gutterRef.current.scrollTop = textarea.scrollTop;
    }
    // `value` is read for the line count only; re-running on every keystroke
    // would fight the caret. The nonce is what makes a repeat hit re-apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.nonce]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background font-mono text-[13px] leading-5">
      <pre
        ref={gutterRef}
        aria-hidden
        className="shrink-0 overflow-hidden border-r border-border bg-surface-recessed px-2 py-3 text-right font-mono text-[13px] leading-5 tabular-nums text-muted-foreground select-none"
      >
        {gutterText}
      </pre>
      <textarea
        ref={textareaRef}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={`Edit ${path}`}
        onScroll={(event) => {
          if (gutterRef.current !== null) {
            gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }
        }}
        onChange={(event) => {
          onCaretChange(event.target.selectionStart);
          onChange(event.target.value);
        }}
        onSelect={(event) => onCaretChange(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            // The workspace root handles ⌘S too; without this the keystroke
            // bubbles and fires a second write against the same guard hash,
            // which comes back as a conflict that never happened.
            event.stopPropagation();
            onSave();
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            insertAtCaret(event.currentTarget, "  ", onChange);
          }
        }}
        // No soft wrap: the gutter renders one row per logical line, so a
        // wrapped line would make every number below it drift.
        wrap="off"
        className={cn(
          "min-h-0 flex-1 resize-none bg-transparent py-3 pr-4 pl-3 text-foreground",
          "overflow-auto whitespace-pre",
          "focus-visible:outline-none",
        )}
      />
    </div>
  );
}

function insertAtCaret(
  textarea: HTMLTextAreaElement,
  text: string,
  onChange: (next: string) => void,
): void {
  const { selectionStart, selectionEnd, value } = textarea;
  const next = `${value.slice(0, selectionStart)}${text}${value.slice(selectionEnd)}`;
  onChange(next);
  requestAnimationFrame(() => {
    const caret = selectionStart + text.length;
    textarea.setSelectionRange(caret, caret);
  });
}

function SaveNotice({
  tab,
  onReload,
  onOverwrite,
}: {
  tab: FileTab;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  if (tab.save.kind === "conflict") {
    return (
      <NoticeRow tone="error">
        {tab.path} changed on disk since you opened it.
        <NoticeAction onClick={onReload}>Reload</NoticeAction>
        <NoticeAction onClick={onOverwrite}>Overwrite</NoticeAction>
      </NoticeRow>
    );
  }
  if (tab.save.kind === "error") {
    return <NoticeRow tone="error">{tab.save.message}</NoticeRow>;
  }
  if (tab.file?.kind === "text" && !tab.file.editable && tab.mode === "edit") {
    return (
      <NoticeRow tone="warning">
        This file is too large to edit here — it is shown read-only.
      </NoticeRow>
    );
  }
  return null;
}

function NoticeRow({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "error" | "warning";
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-2 px-4 py-1.5 text-xs",
        tone === "error"
          ? "bg-surface-destructive text-destructive-text"
          : "bg-surface-attention text-foreground",
      )}
    >
      {children}
    </div>
  );
}

function NoticeAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded-sm font-medium underline underline-offset-2 hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

function Centered({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-wrap items-center justify-center gap-2 p-8 text-sm",
        tone === "error" ? "text-destructive-text" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

export function fileMetaLabel(tab: FileTab): string {
  if (tab.file === null) return "";
  const language = languageLabel(tab.path);
  if (tab.file.kind === "text") {
    const lines = tab.file.content === "" ? 0 : tab.file.content.split("\n").length;
    return `${language} · ${lines.toLocaleString()} lines · ${formatBytes(tab.file.sizeBytes)}`;
  }
  return `${language} · ${formatBytes(tab.file.sizeBytes)}`;
}
