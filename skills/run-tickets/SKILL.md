---
name: run-tickets
description: >
  Implement a set of tk tickets (an epic's children or an explicit list) in parallel
  using the run-tickets workflow: pooled worktrees, one fresh implementer per ticket,
  AC verification when the ticket has acceptance criteria, adversarial quality review,
  and one-at-a-time merges into an integration branch. Use only when the user types
  /run-tickets.
argument-hint: "<epic-id> | <ticket-id> [ticket-id ...] [--resume]"
disable-model-invocation: true
model: sonnet
---

# Run Tickets

You prepare a ticket run, hand it to the `run-tickets` workflow, and report the
result. The workflow script owns all scheduling: dependency order, the worktree
pool, verification, rework caps, and merge serialization. You do not implement,
review, or route messages. Everything you do happens before the workflow starts
or after it returns.

## Phase 0: Parse arguments

`$ARGUMENTS` is either a single epic ID (its open children are the run) or one
or more ticket IDs. `--resume` means a previous run was interrupted: include
tickets already marked `in_progress` and reuse existing branches.

No arguments: print the usage line from `argument-hint` and stop.

## Phase 1: Plan

Resolve the tickets and their dependency graph with the planning helper. It
reads `tk`, drops tickets that cannot run, and prints JSON:

```bash
run-tickets-plan [--include-in-progress] <args>
```

Pass `--include-in-progress` only for `--resume`. The output has `tickets`
(topologically ordered, each with in-set `deps`, `has_ac`, `files`),
`excluded` (with reasons), `cycles`, `overlaps`, `unannotated`, and `stats`.

If `tickets` is empty, show the `excluded` list and stop.

**File overlaps.** Each entry in `overlaps` names a file touched by two or more
tickets with no dependency path between them. Those will likely conflict at
merge. Propose `tk dep <later> <earlier>` edges (earlier = the ticket that
defines the shared surface, else the lower ID) and ask once whether to add them.
If yes, run the `tk dep` calls and re-run `run-tickets-plan`.

**Findings parent.** Out-of-scope finding tickets are parented here:
- Epic mode: the epic's parent if it has one (`tk show <epic-id>`), otherwise
  the epic itself.
- ID mode: `shared_parent` if non-null. Otherwise a session epic, created in
  Phase 2 after confirmation.

**Pool size.** `SLOTS = min(4, number of tickets)`. Slots are just worktrees;
idle ones cost nothing.

Present the plan:

```
Run: <epic <id>: <title> | <N> tickets>
Tickets: <N> runnable (<K> with AC), <R> ready now · longest chain <L> · max width <W>

  [<id>] <title>  deps: <ids or ->  AC: <yes|no>
  ...

Excluded:
  [<id>] <title>: <reason>
Warnings: <overlaps not sequenced, unannotated tickets, or "none">

Integration branch: <epic/<id> | run/<stamp>>   Slots: <SLOTS>
Findings parent: <id | new session epic>
```

Confirm with `AskUserQuestion` (header "Run tickets"): **Proceed
(Recommended)** or **Cancel**. Stop on Cancel. Nothing has been changed yet.

## Phase 2: Set up

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
STAMP=$(date +%Y%m%d-%H%M%S)
```

Integration branch: `epic/<epic-id>` in epic mode, `run/<STAMP>` in ID mode.
On `--resume` in ID mode, ask the user which existing `run/*` branch to reuse
(`git branch --list 'run/*'`).

1. **Branch.** Create it from `main` if it does not exist:
   `git show-ref --verify --quiet refs/heads/<branch> || git branch <branch> main`.
   If it is checked out in the main repo (`git branch --show-current`), stop and
   ask the user to switch away: it must be free for the integration worktree.
2. **Stale worktrees.** `git worktree list` showing `.worktrees/run-*` entries
   means an earlier run did not clean up. Report them and ask before removing.
3. **Worktrees.** Use `worktree-init`, not `git worktree add`, so
   `.worktreelinks` (including `.tickets/`) is applied:
   ```bash
   worktree-init run-$STAMP-integration $REPO_ROOT <branch>
   worktree-init run-$STAMP-slot-1 $REPO_ROOT
   # ... through run-$STAMP-slot-<SLOTS>
   ```
   Each call prints the absolute worktree path on stdout. Record them.
4. **Session epic** (ID mode with no shared parent only):
   `tk create "run-tickets $STAMP" -t epic -p 2 -d "Findings from /run-tickets over <ids>"`.
5. **Claim.** `tk start <id>` for every runnable ticket, so a concurrent run
   cannot pick them up.

## Phase 3: Launch the workflow

First write the run record `<REPO_ROOT>/.worktrees/run-$STAMP.json` with the
Write tool. `/run-status` reads it: Claude Code keeps no copy of a workflow's
args it can find until the run has finished.

```json
{ "stamp": "<STAMP>", "launched": "<ISO-8601 local time>", "args": { ...same object as below... } }
```

Then launch:

```
Workflow({
  name: "run-tickets",
  args: {
    repoRoot: "<REPO_ROOT>",
    integrationBranch: "<branch>",
    integrationWorktree: "<integration worktree path>",
    slots: ["<slot-1 path>", ...],
    findingsParent: "<id>",
    tickets: [{ id, title, deps, has_ac }, ...]   // from the plan, same order
  }
})
```

If the name is not found, launch the same thing with
`scriptPath: "~/.claude/workflows/run-tickets.js"` expanded to an absolute path.
Saved workflows are read once per session, so if `run-tickets.js` was edited
during this session, launch by `scriptPath` to get the current version.

Pass `args` as a JSON object, not a string. The launch result prints a `Run ID`
(`wf_...`); add it to the run record as `"runId"`. Then tell the user:

> Run started. Watch it live with `/workflows` (phases, each agent's tool calls,
> and a log line per ticket state change), or ask for `/run-status` for a
> ticket-by-ticket snapshot. Your session stays free meanwhile.

Do not poll. You are notified when the workflow completes.

**If the run is stopped or dies:** in this session, relaunch with
`Workflow({ scriptPath, resumeFromRunId })`; finished agents replay from cache.
From a new session, run `/run-tickets <same args> --resume`. Merged tickets are
already closed in `tk`, and unfinished `ticket/<id>` branches are picked up
where they left off.

## Phase 4: Record outcomes and clean up

The workflow returns `{ integrationBranch, mergeHalted, integration, tickets }`.
Each entry in `tickets` has an `outcome`:

- `merged`: the merge step already closed it. Confirm with `tk show`; close it
  if it is somehow still open.
- `blocked`: hit a cap, or an agent failed. Reopen it and record why. Its
  `ticket/<id>` branch is kept for inspection or a later `--resume`:
  ```bash
  tk status <id> open
  tk add-note <id> "/run-tickets: blocked: <reason>. Work so far is on branch ticket/<id>."
  ```
- `stalled`: never started because a dependency did not merge. Reopen it with
  a note naming the dependency.

If `mergeHalted` is set, the integration worktree was in an unexpected state.
Leave that worktree in place and show the user its `git status`.

Remove the worktrees without `--force`, integration worktree first so the
branch is free for `/wrap-epic`:

```bash
git worktree remove <integration worktree path>
git worktree remove <slot path>   # each slot
```

If a removal fails (a blocked implementer left uncommitted changes), leave that
worktree and list it in the report.

`worktree-init` without a branch argument creates a placeholder branch named
after each slot. Delete them once their worktrees are gone:
`git branch -D run-$STAMP-slot-<N>`. Delete the `ticket/<id>` branch of each
merged ticket, but only once it is confirmed to be contained in the integration
branch (`git branch -d` checks against the current branch, which is `main`, so
it cannot be used here):

```bash
git merge-base --is-ancestor ticket/<id> <branch> && git branch -D ticket/<id>
```

Keep the branches of blocked tickets.

Last, delete the run record `.worktrees/run-$STAMP.json`, unless a worktree was
left in place (then the run is not fully cleaned up and the record still helps).

## Phase 5: Report

```
/run-tickets finished on <branch>: <M> merged, <B> blocked, <S> stalled

  [<id>] <title>  merged <sha>   (AC fails <n>, review rounds <n>, conflicts <n>)
  [<id>] <title>  BLOCKED: <reason>
  [<id>] <title>  stalled: <reason>

Integration check: <pass | fail: summary | no_checks | skipped>
Findings filed: <ids from each ticket's findings + outOfScope, or "none">
Worktrees left in place: <paths or "none">

Next:
  git log --oneline main..<branch>
  /code-review high  (or /multi-review) on main...<branch>
  tk triage --epic <findings parent> --sort priority,confidence
  /run-tickets <blocked ids> --resume     # after addressing the block reasons
  /wrap-epic <epic-id or branch>          # merge to main when satisfied
```

Findings from `/code-review` or `/multi-review` can go straight back through
`/run-tickets <finding-epic-id>`.
