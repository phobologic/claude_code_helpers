---
name: wrap-epic
description: Ship a completed /run-tickets, /run-epic or /fix-tickets batch: merge the integration branch to main, prune worktrees, move leftover non-blocking findings to the repo's backlog epic, close the epic with a ship note, and report remaining work. Use only when the user types /wrap-epic.
argument-hint: "[epic-id]"
disable-model-invocation: true
model: sonnet
---

# Wrap Epic

Finalize a completed `/run-tickets`, `/run-epic` or `/fix-tickets` run: merge
the integration branch into main, clean up, move findings that should not hold
the epic open to the repo's backlog, close the epic if nothing is left, and
show what remains.

**This skill performs destructive operations.** Present the plan and get
explicit confirmation before changing anything.

## Phase 1: Gather

From the repo root, run the planning script. It is read-only and prints JSON:

```bash
wrap-epic-plan $ARGUMENTS
```

It resolves the epic and its integration branch (`epic/<id>`, or the `run/*`
or `fix/batch-*` branch that merged the epic's tickets, or the current branch
when no id is given) and sorts the epic's open children into:

- `blocking`: tagged `regression`, `worsened`, `deferred-rework` or
  `needs-human`, or a finding at P0-1. This epic's own breakage, review
  findings deferred so a ticket could merge, serious bugs, and criteria the
  owner must sign off.
- `movable`: other findings (pre-existing medium and low ones, older findings
  with no origin tag). They go to the backlog by default.
- `unfinished`: every other open child. They keep the epic open.

Do not re-classify by reading tags yourself; the script is the definition
`/run-tickets` uses too.

Then:

- **`resolved_from` is set:** the id given was a planning epic with no branch
  of its own (like `/spec`'s top-level epic), and the script picked its one
  sub-epic that has a branch. Say so at the top of the plan, and use
  `epic.id` (the sub-epic) everywhere below.
- **Exit 1:** show its message. If it needs an epic id, ask for one.
- **`branch` is null:** with `branch_candidates`, ask which one
  (`AskUserQuestion`) and re-run with `--branch <name>`. Without candidates,
  show `branch_note` and offer to wrap without a merge (move and close only)
  or stop.
- **Duplicates:** for each movable finding with `backlog_matches`, read the
  finding and its matches (`tk show-multi`). A match is a duplicate when it
  describes the same problem in the same function or rule, not just the same
  file. For a movable finding with no `files`, search by the function or rule
  in its title: `tk backlog find <symbol>`.
- **Blockers that stop the wrap** until the user resolves them:
  - `main_repo.dirty`: uncommitted changes in the main repo.
  - `branch.checked_out_at` is a path other than the main repo, unless that
    worktree is in `worktrees`, not `other_run`, and not dirty. Then the
    prune step removes it before the merge.
  - `branch.exists` is false.

## Phase 2: Present the plan and confirm

Show one plan in this shape. Leave out steps that do not apply (no merge
without a branch; no move or close for the backlog epic).

```
Wrapping epic <id>: <title>
  (<resolved_from.id> "<title>" is a planning epic; wrapping its sub-epic <id>)   <- only with resolved_from

Will do:
  1. Prune worktrees:
       .worktrees/run-20260101-000000-integration
       .worktrees/run-20260101-000000-slot-2    (dirty: will be skipped)
     Left alone (belongs to another run):
       .worktrees/run-20260102-000000-slot-1
  2. Merge <branch> -> main   (N commits, M files; main has K commits the branch lacks)   [destructive]
  3. Delete local branch <branch>                                                       [destructive]
  4. Move <J> non-blocking findings to backlog <backlog-id>
       ab-ijkl  P3  preexisting  "Tooltip wraps on narrow screens"
       ab-mnop  P2  (no origin)  "Retry count is not configurable"   -> duplicate of ab-qrst: note + close
  5. Close epic <id> with a ship note
     then close parent <parent.id> "<title>": nothing else is open under it   <- only with parent.close_with_epic
  6. Report remaining work under <parent-id>

Will NOT do:
  - Push to remote (you push manually)
  - Delete the remote branch
  - Run tests or /multi-review

Blocking findings still open under this epic:
     ab-abcd  P1  preexisting  "Null deref in login handler"
     ab-efgh  P3  regression   "Webhook sender drops the retry header"
  Recommended: stop and run /run-tickets <epic-id> first. You can merge anyway:
  they stay open, so the epic stays open.

Unfinished (the epic will not be closed):
     ab-wxyz  P2  task  "Add export button"
```

A `main` that moved on needs nothing special: the `--no-ff` merge handles it,
and a conflict stops the wrap (Phase 3). Never suggest rebasing the
integration branch; it would flatten the `Merge <id>:` commits the runners and
this script rely on.

Rules:
- List every blocking and unfinished ticket with priority, origin or why, and
  title. Never hide them. Merging anyway is the user's call.
- Movable findings go to the backlog unless the user keeps some in the epic.
- A blocking finding moves to the backlog only if the user names it by id, as
  an exception to the rule. Priority never makes a finding movable: a P3
  regression blocks. `needs-human` tickets never move; the owner closes them.
- If `backlog` is null, step 4 creates it (`tk backlog ensure`).
- If `epic.is_backlog`, merge and prune only. The backlog epic is never closed.

Confirm with `AskUserQuestion` (header "Wrap epic"): **Proceed**, **Skip the
merge**, **Cancel**. Put **Cancel** first and mark it "(Recommended)" when
there are blocking findings; otherwise mark **Proceed**. The automatic
"Other" takes trims such as "close only" or an exception by id. Anything that
is not a clear go-ahead: stop.

## Phase 3: Execute

Run the steps in order from the repo root, reporting each. Stop at the first
error; do not recover silently.

1. **Prune worktrees.** For each listed path that is not `other_run`:
   `git worktree remove <path>`. If one fails (uncommitted changes, locked),
   report it and skip it. If it was the worktree holding the branch, stop
   before the merge.
2. **Merge to main.**
   ```bash
   git checkout main
   git merge --no-ff <branch>
   ```
   On a conflict, list the files (`git diff --name-only --diff-filter=U`),
   run `git merge --abort`, and stop. Never resolve conflicts here.
3. **Delete the branch.** `git branch -d <branch>`. Non-force: a refusal means
   step 2 did not merge it, so surface that.
4. **Move findings to the backlog.**
   ```bash
   BACKLOG=$(tk backlog ensure)
   tk set <id> --parent $BACKLOG      # each movable finding with no duplicate
   tk add-note <id> "Moved from <epic-id> at wrap: not blocking that epic."
   ```
   A duplicate: keep the backlog ticket and fold this one into it.
   ```bash
   tk add-note <existing-id> "Seen again in <epic-id> as <id>: <its title>. <anything its body adds>"
   tk add-note <id> "Duplicate of <existing-id>; closed at wrap of <epic-id>."
   tk close <id>
   ```
   A blocking finding moved as an exception gets the note "Moved from
   <epic-id> at wrap as an exception, at the user's request." and keeps its
   origin tag.
5. **Close the epic.** Re-run `wrap-epic-plan <epic.id> --branch <branch>`.
   Close only if `closeable` is true and `movable` is empty:
   ```bash
   tk add-note <epic-id> "Shipped: <N> tickets closed, <M> commits, touched <K> files. Merged to main at <sha>."
   tk close <epic-id>
   ```
   `<M>` and `<K>` are `ahead_of_main` and `files_changed` from Phase 1, `<N>`
   is the epic's closed children (`tk query '.parent == "<epic-id>" and .status == "closed"'`),
   `<sha>` is `git rev-parse HEAD` after the merge. Otherwise skip the close
   and say what keeps it open.

   **Then the parent**, if the plan listed it and the epic did close: confirm
   the re-run's `parent.close_with_epic` is still true, then
   ```bash
   tk add-note <parent-id> "All work shipped: closed with <epic-id> at wrap. Merged to main at <sha>."
   tk close <parent-id>
   ```
6. **Report remaining work** one level above the highest epic still open:
   ```bash
   tk epic-tree <parent-id>     # the epic's parent, or the parent's parent if step 5 closed it
   tk epic-tree                 # when there is no such epic: all root epics
   ```
   Print the output verbatim in a fenced code block; do not also dump
   `tk ready`. If the parent has open non-epic children of its own, list them
   with ID, priority and title:
   `tk query '.parent == "<parent-id>" and .type != "epic" and .status != "closed"'`.

## Phase 4: Summary

```
Wrapped <epic-id>.
  ✓ Pruned <K> worktrees (<S> skipped: <paths>)
  ✓ Merged <N> commits to main
  ✓ Deleted branch <branch>
  ✓ Moved <J> findings to backlog <backlog-id> (<D> folded into existing tickets)
  ✓ Closed epic (with ship note)   | Epic left open: <what keeps it open>
  ✓ Closed parent <parent-id> (nothing left under it)   <- only when step 5 closed it
  Remaining in <parent-id>: <S> open sub-epics, <T> open direct tickets

Remember to `git push` when ready.
```

## Conventions

- Never push to remote. The user pushes manually.
- Never use `--force` on `git branch -d` or `git worktree remove`. If a
  non-destructive attempt fails, surface the reason and let the user decide.
- Never remove a worktree marked `other_run`.
- Never close a ticket without first adding a note that explains why.
- Never close the backlog epic.
- If anything looks unexpected (unknown branch, orphan worktrees, mismatched
  epic metadata), stop and ask rather than guessing.
