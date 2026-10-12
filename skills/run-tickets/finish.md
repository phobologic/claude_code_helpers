# Run Tickets: finish

Read this when the `run-tickets-engine` workflow's completion notification arrives. It
records each ticket's outcome, cleans up, and writes the report. The
workflow's return value is the JSON in the notification's `<result>`.

Contents:
1. Record outcomes and clean up (`run-tickets-finish`)
2. Judge what the script cannot
3. Find what blocks the wrap (`wrap-epic-plan`)
4. Report

## 1. Record outcomes and clean up

From the repo root:

```bash
run-tickets-finish <run-id>
```

It reads the run record and the workflow's result, then: archives the run's
metrics to `~/.claude/run-history/` (before anything the archive reads is
removed); closes merged tickets that are still open; reopens blocked and
stalled tickets with a note giving the reason; files each `DISPUTED:` human
check of a merged ticket as a `needs-human` ticket under the findings parent;
removes the worktrees without `--force` (integration first); deletes slot
placeholder branches and the `ticket/<id>` branches the integration branch
contains; and deletes the run record unless a worktree was left in place. It
prints a JSON report, which the steps below read.

If it says there is no result yet, write the notification's `<result>` JSON to
`.tmp/run-result-<stamp>.json` with the Write tool and run it again with
`--result <that file>`. Delete the file afterwards.

## 2. Judge what the script cannot

- **`needs_decision`**: the implementer says the ticket needs a choice the
  ticket does not settle. Check that claim the way Phase 1 "Decisions" step 1
  does, against the ticket, its notes, and the docs. If it holds, tag the
  ticket `decision` too (`tk set <id> --tags <existing>,decision`), so the
  next run asks instead of retrying, and list it under "Left open for you". If
  something does settle it, add a note saying what, leave the tag off, and
  suggest `--resume`.
- **`merge_halted`**: merging stopped for the rest of the run. Say why (the
  value is the merge step's detail). If the integration worktree was left in
  place, it is mid-merge or has changes: show the user `integration_status`. If
  it was removed, it was clean, and `/run-tickets <same args> --resume` picks up
  where the run stopped: tickets that already passed review go straight to
  merge. When the cause was a refused command, check that the project allows
  `git merge` first (the planner's setup warning).
- **`worktrees_left`**, **`branches_kept`** with an unexpected reason, a
  failed `archive`, or any `errors`: list them in the report. None of them
  stops the report.

## 3. Find what blocks the wrap

```bash
wrap-epic-plan <findings_parent> --branch <integration_branch>
```

Its `blocking` list is the stopping rule, the same one `/wrap-epic` applies:
open children tagged `regression`, `worsened`, `deferred-rework` or
`needs-human` at any priority, and any finding at P0 or P1. A P3 regression
blocks exactly as a P1 does: the rule keeps this epic from shipping its own
breakage, and only pre-existing problems go to the backlog. `movable`
findings will move to the backlog at wrap. `unfinished` is everything else
still open under the findings parent: this run's blocked and stalled tickets,
decisions left open, and in ID mode tickets that were not part of the run.

## 4. Report

Use this template exactly, including every `Next:` line that applies. The user
compares reports across runs, so a consistent shape matters more than a
tailored one. Add commentary after the template, not instead of it.

The integration check reports `pass`, `fail` (new failures this run caused),
`preexisting_only` (everything failing also failed on the integration branch
before this run), or `no_checks`. Show new and pre-existing failures
separately; a `preexisting_only` result is not a reason to hold back the merge,
but say what was already broken.

```
/run-tickets finished on <branch>: <M> merged, <B> blocked, <S> stalled

  [<id>] <title>  merged <sha>   (AC fails <n>, review rounds <n>, conflicts <n>, gate fails <n>)
  [<id>] <title>  BLOCKED: <reason>
  [<id>] <title>  stalled: <reason>

Decided by you this run: <id: answer, from decided, one per line, or "none">
Left open for you: <id: decision needed; recommendation; what it holds back, one per line, or "none">
Needs your check: <id: check, from human_checks, one per line, or "none">
Integration check: <pass | fail | preexisting_only | no_checks | skipped>
  new: <failures this run introduced, or "none">
  pre-existing (already failing before this run): <failures, or "none">
Findings in <findings parent>: <ids from findings, or "none">
Backlog <backlog parent>: <ids from backlog>; noted again: <ids from noted, or "none">
Worktrees left in place: <paths or "none">
Blocking wrap: <"none: ready to wrap", or one line per entry in blocking:>
  <id>  P<priority>  <why>  from <source_ticket or "-">  "<title>"
Still open under <findings parent>: <N> unfinished, <K> findings that move to the backlog at wrap

Next:
  git log --oneline main..<branch>
  /review high <branch>                   # files its findings as tk tickets
  /run-tickets <findings parent>          # only if "Blocking wrap" lists findings
  /run-tickets <blocked ids> --resume     # after addressing the block reasons
  /wrap-epic <epic-id or branch>          # when "Blocking wrap" is none
```

Build every line from the two JSON reports, not from your reading of the
tickets. Do not suggest another run to clear `movable` findings or the
backlog; the backlog is worked separately, whenever the user chooses.

Never recommend moving a blocking finding to the backlog. If the user wants
one moved anyway, that is an exception to the rule: say so in those words,
and have them name it by id. Any note you write on the ticket when moving it
records it as an exception, with the origin unchanged.

`/review` files its findings under a review epic, which can go straight back
through `/run-tickets <review-epic-id>`. Plain `/code-review` files nothing.
