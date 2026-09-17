/**
 * File classification shared by the server (what is worth reading as text) and
 * the explorer (what colour a row's glyph takes).
 */

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

/** Extensions BB's read returns as base64 that a browser can still render. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

const BINARY_EXTENSIONS = new Set([
  "7z",
  "bin",
  "class",
  "dll",
  "dmg",
  "doc",
  "docx",
  "dylib",
  "ear",
  "exe",
  "flac",
  "gz",
  "jar",
  "mp3",
  "mp4",
  "mov",
  "o",
  "odt",
  "ogg",
  "otf",
  "pdf",
  "pyc",
  "so",
  "sqlite",
  "sqlite3",
  "tar",
  "tgz",
  "ttf",
  "wasm",
  "wav",
  "webm",
  "woff",
  "woff2",
  "xls",
  "xlsx",
  "zip",
]);

/**
 * A cheap pre-filter so an obviously binary file never round-trips its bytes
 * through RPC. Anything not listed is still read and re-checked against the
 * encoding BB reports, which is the authoritative answer.
 */
export function isProbablyBinaryPath(path: string): boolean {
  const extension = extensionOf(path);
  if (extension === "") return false;
  if (IMAGE_EXTENSIONS.has(extension)) return extension !== "svg";
  return BINARY_EXTENSIONS.has(extension);
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  astro: "Astro",
  c: "C",
  cc: "C++",
  cjs: "JavaScript",
  cpp: "C++",
  cs: "C#",
  css: "CSS",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  go: "Go",
  h: "C",
  hpp: "C++",
  html: "HTML",
  java: "Java",
  js: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  jsx: "JavaScript React",
  kt: "Kotlin",
  less: "Less",
  lua: "Lua",
  markdown: "Markdown",
  md: "Markdown",
  mdx: "MDX",
  mjs: "JavaScript",
  php: "PHP",
  pl: "Perl",
  py: "Python",
  r: "R",
  rb: "Ruby",
  rs: "Rust",
  scss: "Sass",
  sh: "Shell",
  sql: "SQL",
  svelte: "Svelte",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TypeScript React",
  vue: "Vue",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Shell",
};

const LANGUAGE_BY_FILENAME: Readonly<Record<string, string>> = {
  ".env": "Dotenv",
  ".gitignore": "Ignore file",
  ".gitattributes": "Git attributes",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  procfile: "Procfile",
};

export function languageLabel(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const byName = LANGUAGE_BY_FILENAME[name];
  if (byName !== undefined) return byName;
  const extension = extensionOf(path);
  return LANGUAGE_BY_EXTENSION[extension] ?? (extension === "" ? "Plain text" : extension.toUpperCase());
}

export type GlyphTone =
  | "code"
  | "config"
  | "markup"
  | "style"
  | "doc"
  | "media"
  | "plain";

const TONE_BY_EXTENSION: Readonly<Record<string, GlyphTone>> = {
  astro: "code",
  c: "code",
  cc: "code",
  cjs: "code",
  cpp: "code",
  cs: "code",
  css: "style",
  dart: "code",
  env: "config",
  ex: "code",
  exs: "code",
  go: "code",
  h: "code",
  html: "markup",
  ini: "config",
  java: "code",
  js: "code",
  json: "config",
  jsonc: "config",
  jsx: "code",
  kt: "code",
  less: "style",
  lock: "config",
  lua: "code",
  markdown: "doc",
  md: "doc",
  mdx: "doc",
  mjs: "code",
  php: "code",
  py: "code",
  rb: "code",
  rs: "code",
  scss: "style",
  sh: "code",
  sql: "config",
  svelte: "code",
  swift: "code",
  toml: "config",
  ts: "code",
  tsx: "code",
  txt: "doc",
  vue: "code",
  xml: "markup",
  yaml: "config",
  yml: "config",
};

/** Colour family for a row glyph, mirroring an editor's file-icon palette. */
export function glyphTone(path: string): GlyphTone {
  if (isImagePath(path)) return "media";
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name.startsWith(".")) return "config";
  return TONE_BY_EXTENSION[extensionOf(path)] ?? "plain";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
