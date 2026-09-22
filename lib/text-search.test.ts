import { describe, expect, it } from "vitest";
import {
  PREVIEW_CHARS,
  buildPattern,
  findRawMatches,
  hasBinaryExtension,
  isCaseSensitive,
  looksBinary,
  toLineMatches,
  type SearchQuery,
} from "./text-search.js";

const q = (query: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({
  query,
  matchCase: false,
  wholeWord: false,
  regex: false,
  ...extra,
});

function hits(text: string, query: SearchQuery): string[] {
  const built = buildPattern(query);
  if (!built.ok) throw new Error(built.error);
  return findRawMatches(text, new RegExp(built.source, built.flags), 100).map(
    ([start, length]) => text.slice(start, start + length),
  );
}

describe("smart case", () => {
  it("ignores case for an all-lowercase query", () => {
    expect(isCaseSensitive(q("user"))).toBe(false);
    expect(hits("User user USER", q("user"))).toEqual(["User", "user", "USER"]);
  });

  it("turns exact as soon as the query has a capital", () => {
    expect(isCaseSensitive(q("User"))).toBe(true);
    expect(hits("User user USER", q("User"))).toEqual(["User"]);
  });

  it("is exact whenever Match Case is on", () => {
    expect(hits("User user", q("user", { matchCase: true }))).toEqual(["user"]);
  });

  it("does not read a regex escape like \\W as a capital", () => {
    expect(isCaseSensitive(q("foo\\Wbar", { regex: true }))).toBe(false);
    expect(isCaseSensitive(q("Foo\\wbar", { regex: true }))).toBe(true);
  });
});

describe("literal queries", () => {
  it("treats regex metacharacters as text", () => {
    expect(hits("a.b axb", q("a.b"))).toEqual(["a.b"]);
    expect(hits("arr[0] arr0", q("arr[0]"))).toEqual(["arr[0]"]);
    expect(hits("(a+)+ aaa", q("(a+)+"))).toEqual(["(a+)+"]);
  });

  it("refuses an empty query", () => {
    expect(buildPattern(q("")).ok).toBe(false);
  });
});

describe("whole word", () => {
  it("matches the word, not a word that contains it", () => {
    expect(hits("cat category cat_name bobcat cat.", q("cat", { wholeWord: true }))).toEqual([
      "cat",
      "cat",
    ]);
  });

  it("uses Unicode word boundaries", () => {
    // Under an ASCII \b, "é" is not a word character, so "caf" would match.
    expect(hits("café caf", q("caf", { wholeWord: true }))).toEqual(["caf"]);
  });

  it("falls back to an ASCII boundary for a regex that Unicode mode rejects", () => {
    const built = buildPattern(q("a\\-b", { regex: true, wholeWord: true }));
    expect(built.ok).toBe(true);
    expect(hits("x a-b y", q("a\\-b", { regex: true, wholeWord: true }))).toEqual(["a-b"]);
  });
});

describe("regex queries", () => {
  it("runs the pattern as written", () => {
    expect(hits("id=1 id=22 id=x", q("id=\\d+", { regex: true }))).toEqual(["id=1", "id=22"]);
  });

  it("reports an invalid pattern instead of throwing", () => {
    const built = buildPattern(q("foo(", { regex: true }));
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toBe("Not a valid regular expression: Unterminated group");
  });

  it("skips zero-length matches rather than flooding the results", () => {
    expect(hits("baaab", q("a*", { regex: true }))).toEqual(["aaa"]);
  });
});

describe("findRawMatches", () => {
  it("stops at the limit", () => {
    expect(findRawMatches("aaaaa", /a/g, 3)).toHaveLength(3);
    expect(findRawMatches("aaaaa", /a/g, 0)).toEqual([]);
  });
});

describe("toLineMatches", () => {
  it("reports 1-based lines and columns", () => {
    const text = "first\n  second here\nthird";
    const [row] = toLineMatches(text, [[text.indexOf("here"), 4]]);
    expect(row).toMatchObject({ line: 2, column: 10 });
  });

  it("puts every hit on a line into one row", () => {
    const text = "foo bar foo\nnone\nfoo";
    const rows = toLineMatches(text, [
      [0, 3],
      [8, 3],
      [text.lastIndexOf("foo"), 3],
    ]);
    expect(rows.map((row) => row.line)).toEqual([1, 3]);
    expect(rows[0]!.ranges).toEqual([
      [0, 3],
      [8, 11],
    ]);
  });

  it("drops indentation from the preview and shifts the ranges with it", () => {
    const text = "\t\t  return value;";
    const [row] = toLineMatches(text, [[text.indexOf("value"), 5]]);
    expect(row!.preview).toBe("return value;");
    expect(row!.preview.slice(...row!.ranges[0]!)).toBe("value");
    expect(row!.clippedStart).toBe(false);
  });

  it("strips the \\r of a CRLF line", () => {
    const text = "alpha\r\nbeta\r\n";
    const [row] = toLineMatches(text, [[text.indexOf("beta"), 4]]);
    expect(row!.preview).toBe("beta");
  });

  it("windows a long line around its first hit", () => {
    const text = `${"x".repeat(5000)}NEEDLE${"y".repeat(5000)}`;
    const [row] = toLineMatches(text, [[5000, 6]]);
    expect(row!.preview.length).toBeLessThanOrEqual(PREVIEW_CHARS);
    expect(row!.preview.slice(...row!.ranges[0]!)).toBe("NEEDLE");
    expect(row!.clippedStart).toBe(true);
    expect(row!.clippedEnd).toBe(true);
  });

  it("clips a multi-line hit to the line it starts on", () => {
    const text = "one two\nthree";
    const [row] = toLineMatches(text, [[4, 9]]);
    expect(row!.line).toBe(1);
    expect(row!.preview.slice(...row!.ranges[0]!)).toBe("two");
  });

  it("counts lines correctly deep into a file", () => {
    const text = `${"line\n".repeat(999)}target`;
    const [row] = toLineMatches(text, [[text.indexOf("target"), 6]]);
    expect(row!.line).toBe(1000);
  });
});

describe("binary detection", () => {
  it("calls a buffer with a NUL near the start binary", () => {
    expect(looksBinary(new Uint8Array([72, 105, 0, 1]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("plain text"))).toBe(false);
  });

  it("recognises binary extensions case-insensitively", () => {
    expect(hasBinaryExtension("assets/logo.PNG")).toBe(true);
    expect(hasBinaryExtension("src/app.ts")).toBe(false);
    expect(hasBinaryExtension("Makefile")).toBe(false);
    // A dot in a directory name is not an extension.
    expect(hasBinaryExtension("v1.png/readme")).toBe(false);
  });
});
