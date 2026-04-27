---
name: epic-tree
description: Show a tree of epics with open/closed ticket counts. Use when the user asks to see an epic tree, visualize epic hierarchy, or show ticket counts by epic.
disable-model-invocation: true
model: haiku
---

Run `tk epic-tree` with the arguments from the user's command and display the output verbatim.

Parse the command arguments directly from the user's message:
- Any ticket IDs (e.g. `pbp-c0ll`, `abc-1234`) are positional arguments
- `--all` flag shows closed sub-epics (omit it if not specified)

Examples:
- `/epic-tree` → `tk epic-tree`
- `/epic-tree pbp-c0ll` → `tk epic-tree pbp-c0ll`
- `/epic-tree pbp-c0ll --all` → `tk epic-tree pbp-c0ll --all`
- `/epic-tree abc-1 abc-2` → `tk epic-tree abc-1 abc-2`

Run the command with the Bash tool, then **print the full command output verbatim as your text response** — inside a fenced code block so it renders as-is. The Bash tool result is often collapsed in the UI (e.g. "+N lines, ctrl+o to expand"), so you must reproduce it in your own message. Do not summarize, truncate, reformat, or add commentary.
