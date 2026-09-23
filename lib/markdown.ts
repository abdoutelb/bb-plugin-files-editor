/**
 * Which files the rendered view will take, and how large a one it will render.
 * Both the tab state and the toolbar ask these questions, so they live beside
 * the rest of the file classification rather than in either caller.
 */

import { extensionOf } from "./file-kind.js";

export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown"]);

/**
 * `.mdx` is deliberately absent. It is JSX wearing markdown's extension, and a
 * CommonMark renderer either prints the components as literal text or drops
 * them — strictly worse than reading the source.
 */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

/** What the pane shows: rendered markdown, BB's source viewer, or an editor. */
export type FileViewMode = "preview" | "read" | "edit";

/**
 * BB's markdown renderer is its chat message renderer: it parses the whole
 * document and builds the entire element tree in one synchronous pass, with no
 * virtualization — unlike the source viewer, which measures and settles over
 * several frames. A long README is tens of kilobytes, so a million characters
 * already allows an order of magnitude more than anything written to be read;
 * past it the parse blocks the surface for long enough to look like a hang.
 *
 * Counted in characters (`text.length`), not bytes. The parse costs what the
 * text costs, whatever its encoding on disk, and every caller has the text in
 * hand: the file as read, the file as written, and the draft being typed. One
 * unit for all three is what keeps a document from being refused on load,
 * allowed after a keystroke, and refused again on save.
 */
export const MARKDOWN_PREVIEW_MAX_CHARS = 1024 * 1024;

/** Whether `text`, as the contents of `path`, is rendered in Preview. */
export function canPreviewMarkdown(path: string, text: string): boolean {
  return isMarkdownPath(path) && text.length <= MARKDOWN_PREVIEW_MAX_CHARS;
}

/**
 * The mode a tab may hold, given the one asked for. `text` is what the tab
 * would render — the draft over the file — or null when it has no text: not
 * read yet, an image, a binary. Preview is the only mode with a precondition,
 * and a tab that fails it shows the source instead.
 */
export function allowedMode(
  requested: FileViewMode,
  path: string,
  text: string | null,
): FileViewMode {
  if (requested !== "preview") return requested;
  return text !== null && canPreviewMarkdown(path, text) ? "preview" : "read";
}
