---
name: wrap-epic
description: Ship a completed /run-epic or /fix-tickets batch — merge the integration branch to main, prune worktrees, close the epic with a ship note, and report remaining work. Use only when the user types /wrap-epic.
argument-hint: "[epic-id]"
disable-model-invocation: true
---

# Wrap Epic

Finalize a completed `/run-epic` or `/fix-tickets` run. The skill merges the
integration branch into main, cleans up ephemeral state, closes the epic if
appropriate, and leaves the user with a clear picture of what remains.

**This skill performs destructive operations.** Always present the plan and ask
for explicit confirmation before executing anything.

## Phase 1 — Identify the epic and integration branch

Determine the epic and branch from arguments or the current branch:

1. If `$ARGUMENTS` contains an epic ID, use it. Otherwise, read the current branch
   with `git branch --show-current`.
2. Branch naming conventions:
   - `/run-epic` produces `epic/<epic-id>`
   - `/fix-tickets` produces `fix/batch-<timestamp>` with a batch epic whose ID is
     stored as the parent of its child tickets
3. If the user gave an epic ID, derive the branch:
   - Try `epic/<id>` first
   - If not found, search for a recent `fix/batch-*` branch whose tickets share
     that epic as parent
4. If neither the argument nor the current branch resolves, stop and ask the user
   which epic they want to wrap.

Once resolved, look up:
- Epic ticket (`tk show <epic-id>`) — title, parent, any open child tickets
- Integration branch commit range vs `main` (`git log main..<branch> --oneline`)
- Open findings: children of the epic with status `open` or `in-progress`
- Worktrees to clean: `git worktree list` filtered to paths under `.worktrees/`
  that belong to this run (implementer-*, fix-batch-* matching the branch stamp)

## Phase 2 — Present the plan and ask for confirmation

Show a single, structured plan before taking any action. Use this exact shape:

```
Wrapping epic <id>: <title>

Will do:
  1. Merge <branch> → main           (N commits, M files)            [destructive]
  2. Delete local branch <branch>                                     [destructive]
  3. Prune worktrees:
       .worktrees/implementer-1-...
       .worktrees/implementer-2-...
  4. Close epic <id> with a ship note
  5. Report sub-epic status under <parent-id> (if present)

Will NOT do:
  - Push to remote (you push manually)
  - Delete the remote branch
  - Run tests or /multi-review

⚠ Open review findings still parented under this epic:
     pbp-abcd  P1  "Fix null deref in login handler"
     pbp-efgh  P2  "Add retry to webhook sender"
  You can merge anyway, defer the fixes, or stop and fix first.

Proceed? (yes / yes but skip merge / no)
```

Rules:
- If open findings exist, list them explicitly with priority and title — never
  hide them. The user may still choose to merge; that's their call, not yours.
- If the epic has open non-finding children (tickets that weren't part of this
  run), list them separately and refuse to close the epic even on proceed.
- If the branch has unpushed or uncommitted changes, surface that in the plan
  and treat it as a blocker the user must resolve first.
- If `main` has diverged from the integration branch's base, note it and
  recommend a rebase/merge before proceeding.

Wait for explicit confirmation. Accept: `yes`, `y`, `proceed`. Variants like
"yes but skip merge" or "close only" should be honored by trimming steps.
Anything else — stop.

## Phase 3 — Execute

Run the steps in order, reporting progress as you go. Fail fast if any step
errors — do not attempt to recover silently.

1. **Merge to main.** From the repo root:
   ```
   git checkout main
   git merge --no-ff <branch>
   ```
   If the merge fails, stop. Do not attempt to resolve conflicts automatically.
2. **Delete integration branch.** `git branch -d <branch>` (non-force; if the
   branch isn't fully merged something went wrong with step 1, surface it).
3. **Prune worktrees.** For each worktree path:
   ```
   git worktree remove <path>
   ```
   If removal fails (uncommitted changes, locked), report the path and skip —
   don't force-remove. The user can inspect.
4. **Close the epic.** Only if all children are closed:
   ```
   tk add-note <epic-id> "Shipped: <N> tickets closed, <M> commits, touched <K> files. Merged to main at <sha>."
   tk close <epic-id>
   ```
   If the epic has open non-finding children, skip close and say so.
5. **Report remaining work.** If the epic has a parent:
   ```
   tk epic-tree <parent-id>
   ```
   Print the full output verbatim in a fenced code block.
   Then run `tk ready` and surface the top 1–2 items in the parent epic (or
   repo-wide if no parent) as suggested next steps.

## Phase 4 — Summary

End with a short summary of what happened:

```
Wrapped <epic-id>.
  ✓ Merged <N> commits to main
  ✓ Deleted branch <branch>
  ✓ Pruned <K> worktrees
  ✓ Closed epic (with ship note)
  Remaining in <parent-id>: <count> open sub-epics

Next up: <ticket-id> — <title>

Remember to `git push` when ready.
```

## Conventions

- Never push to remote. The user pushes manually.
- Never use `--force` on `git branch -d` or `git worktree remove`. If a
  non-destructive attempt fails, surface the reason and let the user decide.
- Never close a ticket without first adding a note that explains what shipped.
- If anything looks unexpected (unknown branch, orphan worktrees, mismatched
  epic metadata), stop and ask rather than guessing.
