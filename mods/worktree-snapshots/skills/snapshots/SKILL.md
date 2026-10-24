---
name: snapshots
description: Find and restore work a command destroyed, using the snapshots the worktree-snapshots mod saves before each Bash command. Use when the user says a command deleted, overwrote or reverted files, asks what changed since a command ran, wants an earlier version of an uncommitted file back, or asks to look at or undo from the snapshots.
---

# Snapshots

Before every Bash command the mod saves the checkout (tracked files as on disk, plus
untracked files that are not ignored and are at most 1 MB) as an entry on the worktree's
snapshot ref. Entries expire after 3 days. `snapctl.py` reads them:

```
python3 -I ${CLAUDE_PLUGIN_ROOT}/bin/snapctl.py list [-n COUNT]
python3 -I ${CLAUDE_PLUGIN_ROOT}/bin/snapctl.py show <entry>
python3 -I ${CLAUDE_PLUGIN_ROOT}/bin/snapctl.py diff <entry> [path ...]
python3 -I ${CLAUDE_PLUGIN_ROOT}/bin/snapctl.py restore <entry> <path ...>
```

Run it from inside the checkout that lost the work; each linked worktree has its own
entries.

## How to read an entry

- An entry is the files **just before** the command beside it ran. To get back what
  `rm -rf build` destroyed, use the entry labelled `rm -rf build`, not the one after.
- `gone` is a file in the entry that is missing on disk now. `changed` differs from the
  entry. `new` exists now but not in the entry, and `restore` never touches it.
- Not-ignored untracked files are in entries, so a deleted draft that was never
  committed is recoverable. Ignored files and untracked files over 1 MB are not.
- A command with no entry ran while the files matched `HEAD` or the entry below it.
  Committed content comes back with `git restore -- <path>`; nothing is lost.
- Use the **id** `list` prints, not the position, once anything else has run. Every
  Bash command, including this tool's, can save a new entry and shift each position by one.

## Recovering

1. `list`, and pick the entry whose command did the damage. If several are plausible,
   `show` them and say which you chose and why.
2. `show <entry>` for the files, `diff <entry> <path>` for what differs in one.
3. Tell the user which paths you will write back and which of those overwrite current
   edits (`changed`) versus recreate a file (`gone`). Name the paths; never restore a
   whole checkout, which the tool refuses anyway.
4. Run `restore <entry> <path ...>`. It is not pre-approved, so the user gets a prompt;
   do not work around that. It saves the current state first, so overwritten edits are
   in the new entry 0. Report what it printed.

If `list` shows nothing, or the work is older than 3 days, say so; there is nothing to
recover from, and `git reflog` / `git fsck --lost-found` are the only other places to look.
