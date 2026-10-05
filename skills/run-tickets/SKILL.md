---
name: run-tickets
description: >
  Implement a set of tk tickets (an epic's children or an explicit list) in parallel
  using the run-tickets workflow: decisions put to the owner before dispatch, pooled
  worktrees, one fresh implementer per ticket, AC verification when the ticket has
  acceptance criteria, adversarial quality review, and gated one-at-a-time merges into
  an integration branch. Use only when the user types /run-tickets.
argument-hint: "<epic-id> | <ticket-id> [ticket-id ...] [--slots N] [--resume]"
disable-model-invocation: true
model: opus
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
tickets already marked `in_progress` and reuse existing branches. `--slots N`
overrides the pool size (see "Pool size"). Remove both flags from the
arguments before passing them to `run-tickets-plan`, except `--resume`, which
becomes `--include-in-progress`.

The user's request wins over this skill's defaults. If they name an
integration branch, a slot count, gates, or anything else this skill would
otherwise choose, use theirs and say so in the plan.

No arguments: print the usage line from `argument-hint` and stop.

## Phase 1: Plan

Resolve the tickets and their dependency graph with the planning helper. It
reads `tk`, drops tickets that cannot run, and prints JSON:

```bash
run-tickets-plan [--include-in-progress] <args>
```

Pass `--include-in-progress` only for `--resume`. The output has `tickets`
(topologically ordered, each with in-set `deps`, `tags`, `has_ac`, `files`),
`excluded` (with reasons), `decisions`, `decision_candidates`, `cycles`,
`overlaps`, `unannotated`, `large`, `setup_warnings`, and `stats`.

If `tickets` is empty, show the `excluded` list and stop.

**Human gates.** Tickets tagged `needs-human` are excluded, with everything
downstream of them. If a ticket's text says a person must do or approve it
(for example "NO AGENT MAY CLOSE THIS TICKET") but it lacks the tag, point it
out and offer `tk set <id> --tags <existing>,needs-human`, then re-run the
planner, rather than excluding it by hand.

**Decisions.** A ticket whose outcome is a choice rather than a fix must not
reach an implementer until the owner has made that choice. An implementer that
meets one alone picks something, and the pick lands looking like any other
change. Do this before anything else in the plan, because answers change what
runs.

1. **Find them.** `decisions` lists tickets tagged `decision`, including
   ones outside the input (`outside_run`) that input tickets wait on.
   `decision_candidates` lists runnable tickets whose wording suggests one
   ("decide", "design call", "untuned"), with the matching sentence. The
   wording check is a hint and misses tickets whose ask is in a note, so read
   every runnable ticket's title and description yourself (`tk show-multi`).
   A ticket is a decision when the right outcome is something the owner would
   notice using the product and the ticket does not settle it: behavior, UX or
   wording, content, tuning numbers and thresholds, scope, or a change to what
   a design doc states (including its explicit non-goals). A ticket that
   offers options but whose answer follows from the code, a design doc, or a
   stated convention is not a decision: note which source settles it and let
   it run.
2. **Prepare each one.** Read the ticket and the docs or code it names. Write
   one line for the decision needed, the realistic options, and your
   recommendation with the reason (the doc, code, or evidence behind it). A
   ticket that says to decide "after a playthrough" or "against real play"
   needs that evidence first: recommend leaving it open unless the evidence is
   already in its notes.
3. **Ask once.** Show the list, numbered, then `AskUserQuestion` (header
   "Decisions"): **Take every recommendation**, **Leave them all open**, or
   **Answer one by one**. One by one: up to 4 questions per call, one per
   decision, with options for the recommendation (first, marked
   "(Recommended)"), the main alternative, and "Leave open"; the automatic
   "Other" takes a custom answer.
4. **Record the answers.**
   - Decided: `tk add-note <id> "Owner decision (/run-tickets, <date>): <answer>"`.
     If it carries the `decision` tag, remove just that tag:
     `tk set <id> --tags <its other tags>` (`tk set` replaces the tag list).
     The ticket runs, and its `decision` field in the workflow args carries
     the answer to its implementer, verifier, and reviewer. If the answer
     differs from what the ticket's acceptance criteria assume (they are
     often written for the recommendation), also add a note that starts
     `ACCEPTANCE CRITERIA:` and restates every criterion for the decided
     option; the verifier reads the latest one. An `outside_run` ticket with
     work to do joins this run: add its id to the arguments.
   - Decided, and the ticket is only the question (nothing to build, like the
     "Decide: ..." tickets `/spec` creates): note the answer and close it
     instead. Add the same note to each ticket that waits on it, and give
     each of those the answer as its `decision` (join several with "; ").
     Restate their criteria as above where the answer changes them.
   - Left open: tag it `decision` if it is not already, and add a note with
     the decision needed and your recommendation, so the next run (or person)
     starts from it.

   Then re-run the planner once all answers are recorded: decided tickets
   and what they unblock join `tickets`, and open ones stay excluded with
   everything downstream of them.

Never let an untagged decision ticket run because nobody asked.

**Setup warnings.** These are repo problems that break agents in fresh
worktrees. Show each one and offer to fix it before proceeding. The common one
is a JS repo with no `node_modules/` line in `.worktreelinks`: offer to append
it (commit that on the main branch only if the user agrees). Do not proceed
past an unfixed setup warning without the user's explicit choice.

**File overlaps.** Each entry in `overlaps` names a file touched by two or more
tickets with no dependency path between them. The workflow handles these
itself: it never runs two tickets that name the same file at once, and holds
the file until the ticket that has it merges or blocks, so the next one starts
from the merged result. Do not add `tk dep` edges for overlaps. A dependency is
permanent, forces one order, and makes the earlier ticket look like it has
dependents, which raises its effort to max. Mention overlaps in Warnings only
when one file is named by four or more tickets, since those will take turns.
Tickets in `unannotated` have no `**Files**:` line, so nothing holds them
apart from others; list them.

**Gates.** Find the project's lint, type check, and test commands (CLAUDE.md,
`package.json` scripts, Makefile or justfile, `pyproject.toml`, CI config).
The merge step runs them on every merged result before it commits, so the
integration branch stays green ticket by ticket and a bad interaction between
two tickets is caught at the merge that caused it. Use check-only forms: a
command that rewrites files (`--fix`, `--write`, `format` without `--check`,
snapshot updates) would leave the integration worktree dirty. Show them in the
plan. If CLAUDE.md or CI config says the full suite is slow, say so: the user
may drop it from the gates, and the final integration check still runs
everything.

**Large tickets.** Each entry in `large` has more than 6 acceptance criteria.
Big tickets take the most review rounds to settle, and one that hits the
rework cap stalls its `dependents`. List them with their criteria count and
dependents, and offer to split each one before running. A split is usually a
reusable core (an algorithm, a parser, a model) plus the features on it, or
one ticket per separately testable command or screen. If the user agrees,
create the new tickets with `tk create`, move the criteria across, wire them
with `tk dep`, close the original with a note naming its replacements, and
re-run the planner. A ticket that already has work on its `ticket/<id>`
branch (a `--resume`) is usually better finished than split. Proceeding
unsplit is the user's call.

**Findings parent.** Out-of-scope finding tickets go next to the work that
produced them, so repeated runs over the same epic keep their findings in one
place:
- Epic mode: the epic itself.
- ID mode: `shared_parent` if non-null (usually the epic the tickets belong
  to). Otherwise a session epic, created in Phase 2 after confirmation.

**Backlog.** Each repo has one standing epic tagged `backlog` (`tk backlog`
prints its id). Reviewers file pre-existing medium and low findings there
instead of under the findings parent, and add notes to tickets that already
exist instead of filing duplicates. That keeps each run's reviews from
refilling the epic with problems it did not cause, so the epic can finish. If
`tk backlog` finds none, it is created in Phase 2. When the run is over the
backlog epic itself, it is both the findings parent and the backlog.

**Pool size.** `SLOTS = min(6, stats.max_width)`, or `--slots N` when given:
never more slots than the dependency graph can use at once, so a strict chain
gets one. Slots are only a concurrency cap, and the workflow fills them with
the tickets the most other tickets wait on first, so being one short on an
unusual graph costs a little time, not correctness.

Present the plan:

```
Run: <epic <id>: <title> | <N> tickets>
Tickets: <N> runnable (<K> with AC), <R> ready now · longest chain <L> · max width <W>

  [<id>] <title>  deps: <ids or ->  AC: <yes|no>  <"decided: <answer>" when the owner decided it>
  ...

Excluded:
  [<id>] <title>: <reason>
Left open for you: <decision tickets and what each holds back, or "none">
Warnings: <setup warnings, files shared by 4+ tickets, unannotated tickets, large tickets, or "none">

Integration branch: <branch> (<integration.reason>; <N> ahead of main, <M> behind)   Slots: <SLOTS>
Gates on every merge: <commands, or "none: integration check only">
Findings parent: <id | new session epic>   Backlog: <id | new, created at setup>
```

Confirm with `AskUserQuestion` (header "Run tickets"): **Proceed
(Recommended)** or **Cancel**. Stop on Cancel. Apart from the decision notes
and tags from "Decisions", nothing has been changed yet.

## Phase 2: Set up

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
STAMP=$(date +%Y%m%d-%H%M%S)
```

**Integration branch: take it from the planner's `integration` field**, unless
the user named one. Never choose one yourself. When the tickets belong to an epic, `integration.branch`
is `epic/<id>`, even in ID mode: an epic branch that has not reached `main`
yet is where the code these tickets touch lives, so a branch cut from `main`
would not contain it. Only when `integration.branch` is null do you create
`run/<STAMP>` from `main`. On `--resume` with a null branch, ask the user which
existing `run/*` branch to reuse (`git branch --list 'run/*'`).

1. **Branch.** Create it from `main` if it does not exist:
   `git show-ref --verify --quiet refs/heads/<branch> || git branch <branch> main`.
   If it is checked out in the main repo (`git branch --show-current`), stop and
   ask the user to switch away: it must be free for the integration worktree.

   If the branch already existed and `main` has moved on since
   (`git log --oneline <branch>..main` is non-empty), show those commits and
   offer to merge `main` into the branch first. Otherwise fixes made on `main`
   since the last run (a lint config, a broken test) are missing from this one.
   If the user agrees, do the merge in step 3's integration worktree once it
   exists (`git merge --no-edit main` there); on conflict, `git merge --abort`
   and ask.

   After any such merge, record the branch's starting point for the integration
   check: `BASE=$(git rev-parse <branch>)`. The check compares failures against
   this commit, not against `main`, because an epic branch can differ from
   `main` by dozens of commits that are not this run's doing.
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
4. **Gate baseline.** Run each gate once in the integration worktree, timing
   it, with a Bash timeout of 600000 ms. Drop a gate from `gates`, and tell
   the user which one and why, when:
   - it already fails there, since it would fail every merge;
   - it takes more than about 8 minutes, since the merge step's 10-minute
     command limit would cut it off;
   - `git status --porcelain --untracked-files=no` is not empty afterwards,
     since it rewrites files. Restore them with `git checkout -- .` and look
     for its check-only form before dropping it.
   The integration check at the end still runs everything and separates old
   failures from new ones.
5. **Session epic** (ID mode with no shared parent only):
   `tk create "run-tickets $STAMP" -t epic -p 2 -d "Findings from /run-tickets over <ids>"`.
   **Backlog epic:** `BACKLOG=$(tk backlog ensure)`, from the repo root.
6. **Claim.** `tk start <id>` for every runnable ticket, so a concurrent run
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
    backlogParent: "<BACKLOG>",
    baseBranch: "<BASE>",                         // integration branch's starting commit (Phase 2)
    gates: ["<command>", ...],                    // passed the baseline in Phase 2; [] for none
    tickets: [{ id, title, deps, has_ac, files, decision }, ...]   // from the plan, same order
  }
})
```

`decision` is the owner's answer from Phase 1, verbatim; omit it for tickets
that had no open question. A ticket that depends on a closed decision ticket
(answered by hand or in an earlier run) gets that ticket's answer note too.
On `--resume`, rebuild it from the ticket's `Owner decision` note.

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

The workflow's return value arrives in the completion notification, as JSON in
its `<result>`. Read it from there; do not parse the task output file, which
is a transcript, not the result. It is
`{ integrationBranch, mergeHalted, integration, tickets }`, and each entry in
`tickets` has an `outcome`:

- `merged`: the merge step already closed it. Confirm with `tk show`; close it
  if it is somehow still open.
- `blocked`: hit a cap, or an agent failed. Reopen it and record why. Its
  `ticket/<id>` branch is kept for inspection or a later `--resume`:
  ```bash
  tk status <id> open
  tk add-note <id> "/run-tickets: blocked: <reason>. Work so far is on branch ticket/<id>."
  ```
  When the reason contains `needs decision:`, the implementer says it found a
  choice the ticket does not settle. Check that claim the way Phase 1
  "Decisions" step 1 does, against the ticket, its notes, and the docs. If
  it holds, tag the ticket `decision` as well, so the next run asks instead
  of retrying, and list it under "Left open for you". If something does
  settle it, add a note saying what, leave the tag off, and suggest
  `--resume`.
- `stalled`: never started because a dependency did not merge. Reopen it with
  a note naming the dependency.

A merged ticket's `humanChecks` lists criteria the verifier could not settle
from code and tests: the project verifies that layer by running the product,
or the evidence showed the criterion itself was wrong. They go in the report
for the user to check by hand. A check starting `DISPUTED:` means the ticket
merged without meeting a criterion as written, because the verifier agreed
its premise was false. The owner has to confirm that, so file a ticket for
each one under the findings parent (tagged `needs-human`, with the check, the
source ticket, and the merge sha in the description). It then appears in
"Blocking wrap" until the owner closes it.

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

Archive the run's metrics before deleting anything the report reads. Claude
Code deletes the journal and agent logs after 30 days, and the archive is what
later tuning of effort and rework across runs is based on:

```bash
run-tickets-status --archive <run-id>   # writes ~/.claude/run-history/<repo>/<run-id>.json
```

If it fails, say so in the report and carry on; it does not block cleanup.

Last, delete the run record `.worktrees/run-$STAMP.json`, unless a worktree was
left in place (then the run is not fully cleaned up and the record still helps).

## Phase 5: Report

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

Decided by you this run: <id: answer, one per line, or "none">
Left open for you: <id: decision needed; recommendation; what it holds back, one per line, or "none">
Needs your check: <id: what to check by hand, from humanChecks, one per line, or "none">
Integration check: <pass | fail | preexisting_only | no_checks | skipped>
  new: <failures this run introduced, or "none">
  pre-existing (already failing before this run): <failures, or "none">
Findings in <findings parent>: <ids from each ticket's findings + outOfScope, or "none">
Backlog <BACKLOG>: <new ids from each ticket's backlog>; noted again: <ids from noted, or "none">
Worktrees left in place: <paths or "none">
Blocking wrap: <"none: ready to wrap", or one line per open child of the findings parent:>
  <id>  P<priority>  <origin tags: regression | worsened | preexisting, plus deferred-rework>  from <Source ticket>  "<title>"

Next:
  git log --oneline main..<branch>
  /code-review high  (or /multi-review) on main...<branch>
  /run-tickets <findings parent>          # only if "Blocking wrap" lists tickets
  /run-tickets <blocked ids> --resume     # after addressing the block reasons
  /wrap-epic <epic-id or branch>          # when "Blocking wrap" is none
```

"Blocking wrap" is the stopping rule. Findings under the findings parent are
regressions this work caused, or serious bugs, so they are worth another run.
Backlog findings are not. Do not suggest another run to clear the backlog; it
is worked separately, whenever the user chooses.

Build each "Blocking wrap" line from the record, not from your reading of the
finding: the priority and tags from `tk query`, and the source ticket from the
finding's `**Source ticket**` line. A finding with no origin tag shows
`(no origin)`. Priority does not decide whether a finding blocks: a P3
regression blocks exactly as a P1 does, because the rule exists to keep this
epic from shipping its own breakage, and only pre-existing problems are let
through to the backlog.

Never recommend moving a `regression`, `worsened` or `deferred-rework` finding
to the backlog. If the user wants one moved anyway, that is an exception to
the rule: say so in those words, and have them name it by id. Any note you
write on the ticket when moving it records it as an exception, with the
origin unchanged.

Findings from `/code-review` or `/multi-review` can go straight back through
`/run-tickets <finding-epic-id>`.
