/**
 * Which files the rendered view will take, and how large a one it will render.
 * Both the tab state and the toolbar ask these questions, so they live beside
 * the rest of the file classification rather than in either caller.
 */

import { extensionOf } from "./file-kind.js";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/**
 * `.mdx` is deliberately absent. It is JSX wearing markdown's extension, and a
 * CommonMark renderer either prints the components as literal text or drops
 * them — strictly worse than reading the source.
 */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

/**
 * BB's markdown renderer is its chat message renderer: it parses the whole
 * document and builds the entire element tree in one synchronous pass, with no
 * virtualization — unlike the source viewer, which measures and settles over
 * several frames. A long README is tens of kilobytes, so a megabyte already
 * allows an order of magnitude more than anything written to be read; past it
 * the parse blocks the surface for long enough to look like a hang.
 */
export const MARKDOWN_PREVIEW_MAX_BYTES = 1024 * 1024;

/**
 * `sizeBytes` is the best measure the caller has of what would be rendered: the
 * UTF-8 size the read reports, or, for a draft not yet written, its length in
 * UTF-16 units — a floor on that size, and cheap enough to take per keystroke.
 * The cap is a guard against a hang, not an accountant.
 */
export function canPreviewMarkdown(path: string, sizeBytes: number): boolean {
  return isMarkdownPath(path) && sizeBytes <= MARKDOWN_PREVIEW_MAX_BYTES;
}
