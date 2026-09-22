# bb-plugin-files-editor

A VS Code-style file explorer and editor for the workspace behind a bb thread,
laid out the way an editor is: a file tree on the left, editor tabs across the
top, and the whole file in the middle — syntax highlighted, editable, and
searchable across every file in the project.

![Search in files: results grouped by file with each hit highlighted, and the file opened on the chosen line](https://raw.githubusercontent.com/abdoutelb/bb-plugin-files-editor/main/docs/preview.png)

![The file tree, editor tabs, and find in the open file](https://raw.githubusercontent.com/abdoutelb/bb-plugin-files-editor/main/docs/find-in-file.png)

*Illustrations of the layout, not screenshots — drawn from `docs/preview.html`
and `docs/find-in-file.html` with invented project data, so no real repository or
thread titles appear in them.*

## What it gives you

- **A Files page** in the sidebar (`/plugins/files-editor/files`) with a
  workspace picker covering every project checkout and every thread worktree.
- **A Files tab beside a thread** — right panel → new tab → *Project files*.
  Pinned to that thread's workspace, so it shows the files the agent in that
  conversation is editing.
- **Search in files.** The field at the top of the tree searches the *text* of
  every file in the workspace (<kbd>⌘⇧F</kbd>). Results are grouped by file with
  each hit highlighted; click one and the file opens on that line. It is smart
  case — lowercase finds any case, a capital makes it exact — with VS Code's
  toggles beside it: `Aa` match case (<kbd>⌥C</kbd>), `ab` whole word
  (<kbd>⌥W</kbd>), `.*` regex (<kbd>⌥R</kbd>). File contents are kept in memory
  between searches, so refining a query re-runs in tens of milliseconds.
- **Go to file by name.** The magnifier beside the field (<kbd>⌘P</kbd>) is the
  ranked file-name palette, with arrow keys and Enter.
- **Find in file.** Inside the open file, the magnifier in the toolbar (or
  <kbd>⌘F</kbd>): match count, <kbd>Enter</kbd> / <kbd>⇧Enter</kbd> to step, `Aa`
  for case, and the hit is revealed whether you are reading or editing.
- **Project, then workspace.** Two dependent pickers — choose the project, then
  its checkout or one of its worktrees by branch name. Picking a project lands
  on its checkout.
- **Click a file and it opens in full** — its own tab, the complete contents,
  syntax-highlighted by BB's own source renderer, in your BB code theme.
- **Edit and save.** A Read / Edit toggle switches the pane to an editor;
  <kbd>⌘S</kbd> writes. Saves are guarded by the hash the file had when you
  opened it, so if an agent edited it underneath you the save stops and offers
  *Reload* or *Overwrite* rather than clobbering the change.
- **Images render**, other binaries say so instead of dumping bytes.
- **`bb files`** gives an agent the same listing from the CLI.

## Search in files

Type in the field at the top of the tree — or press <kbd>⌘⇧F</kbd> — and the tree
gives way to every line in the project that contains it, grouped by file with a
hit count per file. Click a hit and the file opens on that line, highlighted a
third of the way down so there is context above it. <kbd>Esc</kbd> brings the
tree back. Finding a file by *name* is the magnifier beside the field
(<kbd>⌘P</kbd>).

**Smart case.** `discount` finds any case; `Discount` — with a capital — finds
only that. `Aa` (<kbd>⌥C</kbd>) makes any query exact, `ab` (<kbd>⌥W</kbd>)
matches whole words using Unicode word boundaries, and `.*` (<kbd>⌥R</kbd>) takes
a regular expression.

### How it stays fast

There is no ripgrep to call, so the search engine is the plugin's own, and it is
built around the fact that you refine a query while you type it:

- **File contents stay in memory between searches**, checked against each file's
  size and modification time. The first search reads the workspace from disk;
  every search after that re-runs the pattern over text already in memory.
- **The file list is reused while you type**, instead of walking the workspace
  again for every keystroke.
- **Every search cancels the one it replaces**, on the server as well as in the
  view, so a fast typist never queues a backlog.
- **Files are read in parallel**, binaries are skipped by extension before they
  are opened and by content after, and anything over 2 MB is left out.
- **It stops early.** A very common word stops at 2,000 hits rather than
  scanning the rest of the project for results nobody will scroll to.

Measured on a 6,176-file Laravel project:

| search | time on the server |
|---|---|
| first search after the plugin loads | ~600 ms |
| the same search again | **~65 ms** |
| refining `discount` → `discount_percentage` | ~62 ms |
| a regular expression | ~107 ms |
| a very common word, stopping at the cap | ~8 ms |

**A regex cannot freeze BB.** This plugin runs inside BB's own server process.
A pattern that backtracks catastrophically — `(a+)+$` against a long run of `a`s —
would block that process for minutes. So a regex runs in its own worker thread
with a 3-second deadline, and one that overruns is stopped and reported as too
slow. Plain-text and whole-word searches are escaped before they run, which
makes them linear, so they stay on the fast path.

## Dotfiles

BB's own recursive listing drops every name starting with `.`, which is why
`.github`, `.env.example`, and `.gitignore` are missing from other file trees in
the app. For a workspace on the machine BB's server runs on, this plugin walks
the directory itself and shows them; the eye toggle in the explorer turns them
off.

A workspace on a *connected* machine has to go through BB's listing, so dotfiles
are not available there and the toggle is hidden. The explorer says which mode
it is in.

## The CLI

```
bb files root                 # where the workspace is, and on which machine
bb files tree [--depth n] [--all] [--limit n]
bb files find <query> [--limit n]
bb files read <path>
```

Everything resolves against the thread the command runs in: its worktree when it
has one, otherwise the project's default checkout. It reads through BB, so it
returns the right bytes even when that workspace lives on another machine —
which is exactly when `ls` and `cat` would quietly read the wrong disk.

## Settings

**Excluded directories** — one name per line, matched against any path segment.
Defaults to `.git`, `node_modules`, and `vendor` — the three dependency trees
big enough to truncate a listing on their own. Remove one to browse it, or add
`dist`, `.venv`, `target`. Applies to the tree, the palette, and the CLI.

## Install

```sh
bb plugin install git:https://github.com/abdoutelb/bb-plugin-files-editor.git@^0.1.2
```

That tracks the 0.x line, so `bb plugin outdated` and `bb plugin update` pick up
later releases. To work on it locally instead, clone it and install the path:

```sh
bb plugin install /path/to/bb-plugin-files-editor
```

## Development

```sh
npm install --include=dev
npm test                              # pure logic: trees, ranking, find, paths
npm run typecheck
bb plugin dev                         # rebuild + reload on save
```

`lib/` holds the logic worth testing on its own — tree assembly, the fuzzy
ranker, in-file find, project-wide text search and its content cache, workspace
grouping, workspace-relative path resolution, route encoding. `server.ts` is mostly wiring; the components are the view.

## Limits

- The local walk stops at 40,000 entries and BB's remote listing at 10,000, and
  the explorer mounts at most 600 rows at a time. The footer says when either
  limit is in play; widening *Excluded directories* is the fix for a truncated
  listing.
- Every `bb files` command is capped by BB's 1 MB limit on a command's output.
  Past that it prints what fits — whole lines, for a listing — and says how much
  it cut. BB discards an oversize result rather than truncating it, so the
  clipping is the difference between a partial answer and none.
- The editor is a textarea with a gutter, not a code editor: no completion and
  no multiple cursors, and find in the open file is literal text — no regex,
  no replace (Search in files does take a regex). For
  those, BB's builtin **File Editor** (Monaco) plugin claims the file-preview
  surface; the ↗ button in the toolbar hands it the current file.
- Reading, a find hit highlights its whole line, because line ranges are what
  BB's source viewer accepts. Editing selects the exact match.
- Search in files stops at 2,000 hits, 500 files or 10 seconds, and says so.
  It honours *Excluded directories*, skips binaries and files over 2 MB, and
  searches dotfiles only when the eye toggle shows them.
- A regex runs in its own worker thread with a 3-second deadline. The plugin
  lives inside BB's server, so a pattern that backtracks catastrophically would
  otherwise freeze all of BB; instead it is stopped and reported. Patterns use
  JavaScript syntax.
- On a connected machine, search goes through BB's file API one file at a time:
  it covers the first 3,000 files, keeps them for a minute, and cannot see
  dotfiles.
- Files over 4 MB open read-only.
- The tree does not create, rename, or delete files.
