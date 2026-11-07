---
name: project-files
description: Browse and read files in the current thread's workspace with the `bb files` command. Use when you need the layout of the project, want to find a file by a partial path, or want to print a file relative to the workspace root — especially on a thread whose workspace lives on another machine, where local shell tools would read the wrong disk.
---

# Reading the thread's workspace

`bb files` resolves the workspace behind the current thread — its worktree when
it has one, otherwise the project's default checkout — and reads it through BB,
so it works the same whether that workspace is on this machine or a connected
one.

```
bb files root                 # where the workspace is, and on which machine
bb files tree                 # every file, workspace-relative
bb files tree --depth 2       # only the top two levels
bb files tree --all           # include dotfiles
bb files find auth cont       # fuzzy match against full paths
bb files read config/auth.php # print one file
```

`tree` prints directories with a trailing `/`. It stops at 500 entries unless
you pass `--limit`, and notes when it truncated.

Prefer this over `ls`/`cat` when the thread's workspace may not be on the
machine your shell runs on. For a workspace you know is local, ordinary shell
tools are fine and faster.

The same listing backs the **Files** panel in the app, where clicking a file
opens it with syntax highlighting and an editor.
