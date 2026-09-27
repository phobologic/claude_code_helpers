---
name: wrap-epic
description: Ship a completed /run-tickets, /run-epic or /fix-tickets batch: merge the integration branch to main, prune worktrees, move leftover non-blocking findings to the repo's backlog epic, close the epic with a ship note, and report remaining work. Use only when the user types /wrap-epic.
argument-hint: "[epic-id]"
disable-model-invocation: true
model: sonnet
---

# Wrap Epic

Finalize a completed `/run-tickets`, `/run-epic` or `/fix-tickets` run. The
skill merges the integration branch into main, cleans up ephemeral state, moves
findings that should not hold the epic open to the repo's backlog, closes the
epic if appropriate, and leaves the user with a clear picture of what remains.

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
   - `/run-tickets` produces `epic/<epic-id>` when run on an epic, and
     `run/<timestamp>` when run on a list of ticket IDs
3. If the user gave an epic ID, derive the branch:
   - Try `epic/<id>` first
   - If not found, search recent `fix/batch-*` and `run/*` branches for one whose
     merged tickets share that epic as parent. `/run-tickets` merge commits are
     titled `Merge <ticket-id>: <title>`, so `git log main..<branch> --merges
     --format=%s` lists the ticket IDs to check
4. If neither the argument nor the current branch resolves, stop and ask the user
   which epic they want to wrap.

Once resolved, look up:
- Epic ticket (`tk show <epic-id>`) — title, parent, any open child tickets
- Integration branch commit range vs `main` (`git log main..<branch> --oneline`)
- Open findings: children of the epic with status `open` or `in_progress`,
  split into:
  - **Blocking:** tagged `regression`, `worsened` or `deferred-rework`, or
    priority 0-1. These are this epic's own breakage, review findings deferred
    so a ticket could merge instead of hitting the rework cap, or serious bugs.
  - **Movable:** everything else tagged `code-review`: pre-existing medium and
    low findings, and older findings with no origin tag.
- Backlog epic: `tk backlog` (the repo's one open epic tagged `backlog`).
  If the epic being wrapped *is* the backlog epic, it is never closed: merge
  its branch and prune, but skip the move and close steps.
- Worktrees to clean: `git worktree list` filtered to paths under `.worktrees/`
  that belong to this run: `implementer-*` and `fix-batch-*` (wave skills),
  `epic-dag-*` and `fix-dag-*` (DAG skills), `run-*` (`/run-tickets`, which
  normally removes its own on completion; any left over belong to blocked
  tickets or an interrupted run)

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
  4. Move <K> non-blocking findings to backlog <backlog-id>
       pbp-ijkl  P3  preexisting  "Tooltip wraps on narrow screens"
       pbp-mnop  P2  (no origin)  "Retry count is not configurable"   → duplicate of pbp-qrst: note + close
  5. Close epic <id> with a ship note
  6. Report sub-epic status under <parent-id> (if present)

Will NOT do:
  - Push to remote (you push manually)
  - Delete the remote branch
  - Run tests or /multi-review

⚠ Blocking findings still open under this epic:
     pbp-abcd  P1  preexisting  "Fix null deref in login handler"
     pbp-efgh  P2  regression   "Webhook sender drops the retry header"
  Recommended: stop and run /run-tickets <epic-id> first. You can also merge
  anyway (they stay open, so the epic stays open). Moving one to the backlog
  is an exception to the rule: name it by id if you want that.

Proceed? (yes / yes but skip merge / no)
```

Rules:
- If open findings exist, list them explicitly with priority, origin and
  title. Never hide them. The user may still choose to merge; that's their
  call, not yours.
- Movable findings go to the backlog by default (step 4). The user can keep
  any of them in the epic instead. Blocking findings move only if the user
  says so by id. Priority never makes a finding movable: a P3 regression is
  blocking. The note on a moved blocking finding says it was moved as an
  exception at the user's request and keeps its origin.
- Before moving each one, check the backlog for a duplicate with
  `tk backlog find <path> <symbol>` (from its **Files** line and title). Show
  a duplicate in the plan as "duplicate of <id>: note + close".
- If there is no backlog epic yet, step 4 creates it (`tk backlog ensure`).
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
4. **Move findings to the backlog.** From the repo root:
   ```
   BACKLOG=$(tk backlog ensure)
   tk set <id> --parent $BACKLOG      # each movable finding with no duplicate
   tk add-note <id> "Moved from <epic-id> at wrap: not blocking that epic."
   ```
   For a duplicate, keep the backlog ticket and fold this one into it:
   ```
   tk add-note <existing-id> "Seen again in <epic-id> as <id>: <its title>. <anything its body adds>"
   tk add-note <id> "Duplicate of <existing-id>; closed at wrap of <epic-id>."
   tk close <id>
   ```
5. **Close the epic.** Only if all children are closed:
   ```
   tk add-note <epic-id> "Shipped: <N> tickets closed, <M> commits, touched <K> files. Merged to main at <sha>."
   tk close <epic-id>
   ```
   If the epic has open non-finding children, skip close and say so.
6. **Report remaining work.** Show the epic tree so the user sees what
   sub-epics remain and how many tickets are open inside each:
   ```
   tk epic-tree <parent-id>     # if the wrapped epic has a parent
   tk epic-tree                 # otherwise — all root epics
   ```
   Print the full output verbatim in a fenced code block. The tree already
   shows open/closed ticket counts per epic; do not also dump `tk ready`.

   If the parent epic itself has open non-epic children (tickets parented
   directly to it, not nested in a sub-epic), list them separately with
   `tk query '.parent == "<parent-id>" and .type != "epic" and .status != "closed"'`
   and show ID + priority + title for each. These are work in the parent
   that isn't grouped into a sub-epic.

## Phase 4 — Summary

End with a short summary of what happened:

```
Wrapped <epic-id>.
  ✓ Merged <N> commits to main
  ✓ Deleted branch <branch>
  ✓ Pruned <K> worktrees
  ✓ Moved <J> findings to backlog <backlog-id> (<D> folded into existing tickets)
  ✓ Closed epic (with ship note)
  Remaining in <parent-id>: <S> open sub-epics, <T> open direct tickets

Remember to `git push` when ready.
```

## Conventions

- Never push to remote. The user pushes manually.
- Never use `--force` on `git branch -d` or `git worktree remove`. If a
  non-destructive attempt fails, surface the reason and let the user decide.
- Never close a ticket without first adding a note that explains what shipped.
- Never close the backlog epic (tagged `backlog`). It is permanent.
- If anything looks unexpected (unknown branch, orphan worktrees, mismatched
  epic metadata), stop and ask rather than guessing.
