/**
 * Project-wide text search: turning a query into a pattern, and turning raw
 * match offsets into the rows the results list draws.
 *
 * Every query becomes a RegExp — a literal one is escaped first. That gives one
 * code path for case folding (the `i` flag, rather than lowercasing both sides,
 * which shifts offsets for scripts where case changes a string's length) and
 * for whole-word boundaries, and an escaped literal cannot backtrack.
 */

export interface SearchQuery {
  query: string;
  /** Off means smart case: exact only when the query contains a capital. */
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export type BuiltPattern =
  | { ok: true; source: string; flags: string; caseSensitive: boolean }
  | { ok: false; error: string };

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Smart case. In a regex, escapes like `\W` or `\S` are syntax rather than
 * letters, so they must not flip the search to case-sensitive.
 */
export function isCaseSensitive(query: SearchQuery): boolean {
  if (query.matchCase) return true;
  const probe = query.regex ? query.query.replace(/\\./g, "") : query.query;
  return /\p{Lu}/u.test(probe);
}

export function buildPattern(query: SearchQuery): BuiltPattern {
  if (query.query === "") return { ok: false, error: "Type something to search for." };

  const caseSensitive = isCaseSensitive(query);
  const body = query.regex ? query.query : escapeRegExp(query.query);
  const caseFlag = caseSensitive ? "" : "i";

  const attempts: Array<{ source: string; flags: string }> = [];
  if (query.wholeWord) {
    // A Unicode word boundary, so "café" is one word. A user regex that is not
    // valid in Unicode mode falls back to the ASCII \b rather than failing.
    attempts.push({
      source: `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`,
      flags: `gu${caseFlag}`,
    });
    attempts.push({ source: `\\b(?:${body})\\b`, flags: `g${caseFlag}` });
  } else {
    attempts.push({ source: body, flags: `g${caseFlag}` });
  }

  let lastError = "";
  for (const attempt of attempts) {
    try {
      new RegExp(attempt.source, attempt.flags);
      return { ok: true, ...attempt, caseSensitive };
    } catch (error) {
      // V8 says "Invalid regular expression: /foo(/gi: Unterminated group";
      // keep just the reason, since the pattern is already on screen.
      const message = error instanceof Error ? error.message : String(error);
      lastError = message.slice(message.lastIndexOf(": ") + 2) || message;
    }
  }
  return { ok: false, error: `Not a valid regular expression: ${lastError}` };
}

/** [index, length] pairs in ascending order. */
export type RawMatch = [number, number];

/**
 * Zero-length matches are skipped: a pattern like `a*` matches between every
 * character, which is a flood of empty rows and nothing a person can use.
 */
export function findRawMatches(text: string, pattern: RegExp, limit: number): RawMatch[] {
  const matches: RawMatch[] = [];
  if (limit <= 0) return matches;
  pattern.lastIndex = 0;
  for (;;) {
    const match = pattern.exec(text);
    if (match === null) break;
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    matches.push([match.index, match[0].length]);
    if (matches.length >= limit) break;
  }
  return matches;
}

export interface LineMatch {
  /** 1-based. */
  line: number;
  /** 1-based column of the first hit on the line. */
  column: number;
  /** The line as shown: leading indentation removed, long lines windowed. */
  preview: string;
  /** Hits within `preview`, as [start, end) character offsets. */
  ranges: Array<[number, number]>;
  /** The preview dropped text before or after what it shows. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** Past this a line is windowed around its first hit. */
export const PREVIEW_CHARS = 200;
/** How much context stays visible before the first hit in a windowed line. */
const PREVIEW_LEAD = 40;

/**
 * Groups hits by line, one row per line with every hit on it highlighted.
 * Matches arrive in ascending order, so the line counter only moves forward —
 * one pass over the text however many hits there are.
 */
export function toLineMatches(text: string, raw: readonly RawMatch[]): LineMatch[] {
  const rows: LineMatch[] = [];
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  let index = 0;

  while (index < raw.length) {
    const [firstStart] = raw[index]!;
    for (let cursor = scanned; cursor < firstStart; cursor += 1) {
      if (text.charCodeAt(cursor) === 10) {
        line += 1;
        lineStart = cursor + 1;
      }
    }
    scanned = firstStart;

    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;

    const hits: Array<[number, number]> = [];
    while (index < raw.length && raw[index]![0] < lineEnd) {
      const [start, length] = raw[index]!;
      // A hit that runs past the newline (a multi-line regex) is clipped to
      // the line it starts on, which is the one the row stands for.
      hits.push([start - lineStart, Math.min(start + length, lineEnd) - lineStart]);
      index += 1;
    }

    let full = text.slice(lineStart, lineEnd);
    if (full.endsWith("\r")) full = full.slice(0, -1);
    rows.push({ line, column: hits[0]![0] + 1, ...window(full, hits) });
  }
  return rows;
}

function window(
  full: string,
  hits: ReadonlyArray<[number, number]>,
): Pick<LineMatch, "preview" | "ranges" | "clippedStart" | "clippedEnd"> {
  const indent = full.length - full.trimStart().length;
  let from = indent;
  let to = full.length;
  const firstHit = hits[0]![0];

  if (to - from > PREVIEW_CHARS) {
    from = Math.max(indent, firstHit - PREVIEW_LEAD);
    to = Math.min(full.length, from + PREVIEW_CHARS);
  }

  const ranges: Array<[number, number]> = [];
  for (const [start, end] of hits) {
    const clippedFrom = Math.max(start, from);
    const clippedTo = Math.min(end, to);
    if (clippedTo > clippedFrom) ranges.push([clippedFrom - from, clippedTo - from]);
  }

  return {
    preview: full.slice(from, to),
    ranges,
    clippedStart: from > indent,
    clippedEnd: to < full.length,
  };
}

/** A NUL in the first few KB is how git and ripgrep both decide "binary". */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

/** Skipped before reading: nothing in these is worth a text search. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tif", "tiff", "psd", "heic",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war", "class",
  "dll", "so", "dylib", "exe", "bin", "o", "a", "lib", "wasm", "pyc",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac", "ogg", "webm", "m4a",
  "sqlite", "sqlite3", "db",
]);

export function hasBinaryExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot < path.lastIndexOf("/")) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
