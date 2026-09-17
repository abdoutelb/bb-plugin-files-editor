import { describe, expect, it } from "vitest";
import {
  MARKDOWN_PREVIEW_MAX_BYTES,
  canPreviewMarkdown,
  isMarkdownPath,
} from "./markdown.js";

describe("isMarkdownPath", () => {
  it("takes the two extensions people actually write", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/guide.markdown")).toBe(true);
  });

  it("ignores case, because a shouted README.MD is still markdown", () => {
    expect(isMarkdownPath("README.MD")).toBe(true);
    expect(isMarkdownPath("NOTES.Markdown")).toBe(true);
  });

  it("refuses .mdx, which would render its components as literal text", () => {
    expect(isMarkdownPath("docs/page.mdx")).toBe(false);
  });

  it("reads the extension, not the directories above it", () => {
    expect(isMarkdownPath("docs.md/notes.txt")).toBe(false);
    expect(isMarkdownPath("v1.2.3/CHANGELOG.md")).toBe(true);
  });

  it("reads a file named `.md` as a dotfile, which has no extension", () => {
    expect(isMarkdownPath(".md")).toBe(false);
  });

  it("says no for anything else", () => {
    expect(isMarkdownPath("lib/find.ts")).toBe(false);
    expect(isMarkdownPath("Makefile")).toBe(false);
    expect(isMarkdownPath("")).toBe(false);
  });
});

describe("canPreviewMarkdown", () => {
  it("renders a file at the cap, and falls back one byte over it", () => {
    const cap = MARKDOWN_PREVIEW_MAX_BYTES;
    expect(canPreviewMarkdown("README.md", cap)).toBe(true);
    expect(canPreviewMarkdown("README.md", cap + 1)).toBe(false);
  });

  it("stays false for a small file that is not markdown", () => {
    expect(canPreviewMarkdown("lib/find.ts", 120)).toBe(false);
  });
});
