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

You prepare a ticket run, hand it to the `run-tickets-engine` workflow, and report the
result. The workflow script owns all scheduling: dependency order, the worktree
pool, verification, rework caps, and merge serialization. You do not implement,
review, or route messages. Everything you do happens before the workflow starts
or after it returns.

```
Progress:
- [ ] Phase 0: parse arguments
- [ ] Phase 1: plan, put decisions to the owner, confirm
- [ ] Phase 2: set up (run-tickets-setup, gate baseline)
- [ ] Phase 3: write the run record, launch the workflow
- [ ] Phase 4: when it completes, read finish.md and follow it
```

## Phase 0: Parse arguments

`$ARGUMENTS` is either a single epic ID (its open children are the run) or one
or more ticket IDs. `--resume` means a previous run was interrupted: include
tickets already marked `in_progress` and reuse existing branches. `--slots N`
overrides the pool size. Strip both flags before calling `run-tickets-plan`,
except that `--resume` becomes `--include-in-progress`.

The user's request wins over this skill's defaults. If they name an
integration branch, a slot count, gates, or anything else this skill would
otherwise choose, use theirs and say so in the plan.

No arguments: print the usage line from `argument-hint` and stop.

## Phase 1: Plan

```bash
run-tickets-plan [--include-in-progress] <args>
```

It prints JSON: `tickets` (topologically ordered, each with in-set `deps`,
`tags`, `has_ac`, `files`), `excluded` (with reasons), `decisions`,
`decision_candidates`, `cycles`, `overlaps`, `unannotated`, `large`,
`setup_warnings`, `integration`, and `stats`. If `tickets` is empty, show
`excluded` and stop.

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
   `decision_candidates` lists runnable tickets whose wording suggests one,
   with the matching sentence. The wording check is a hint and misses tickets
   whose ask is in a note, so read every runnable ticket's title and
   description yourself (`tk show-multi`). A ticket is a decision as the
   `decision` gate tag in `~/.claude/tk.md` defines it: its right outcome is
   behavior or wording a user would notice, content, a tuning number, scope,
   or a departure from a design doc (including its explicit non-goals), and
   the ticket does not settle it. A ticket that offers options but whose
   answer follows from the code, a design doc, or a stated convention is not
   a decision: note which source settles it and let it run.
2. **Brief each one.** Assume the owner has not looked at the ticket recently,
   or at the code and systems it touches: decision tickets are usually filed
   days or weeks earlier, by reviewers, playtests or other runs. Before asking
   anything, read the ticket and its notes, the ticket or review it came from
   (its `**Source ticket**` line, notes naming a run), the code it names, and
   the design docs for that area. Then write a brief the owner can decide
   from without opening anything:
   ```
   Decision <n> of <N>: <id> "<title>"
   Where it came from: <who or what filed it, and when: review of <ticket>, a playtest note, by hand>
   What happens today: <current behavior as a user or player sees it> (code: <path:function>)
   Why it's open: <what the ticket, the code and the docs leave unsettled>
   Options:
     A. <option>: <what the owner would notice; cost or risk>
     B. <option>: <same>
   Recommendation: <letter>, because <the doc, code or evidence behind it>
   Holds back: <tickets waiting on it, from the planner's downstream, or "nothing">
   ```
   Describe behavior in product terms; the code reference is for checking,
   not for understanding. A ticket that says to decide "after a playthrough"
   or "against real play" needs that evidence first: recommend leaving it open
   unless the evidence is already in its notes.
3. **Ask one at a time.** Say how many decisions there are. Then, for each:
   show its brief, and ask with `AskUserQuestion` (header "Decision <n>/<N>"),
   one question whose options are your recommendation (first, marked
   "(Recommended)"), the other realistic options (up to three in all), and
   "Leave open". The automatic "Other" takes a custom answer or a request for
   more detail: answer the request, then ask again. Do not offer to accept
   every recommendation at once; if the owner says to take the rest of your
   recommendations, do that.
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
   - Left open: tag it `decision` if it is not already, and add the brief as
     a note, so the next run (or person) starts from it.

   Then re-run the planner once all answers are recorded: decided tickets
   and what they unblock join `tickets`, and open ones stay excluded with
   everything downstream of them.

Never let an untagged decision ticket run because nobody asked.

**Setup warnings.** These are repo problems that break agents in fresh
worktrees. Show each one and offer to fix it before proceeding. The common one
is a JS repo with no `node_modules/` line in `.worktreelinks`: offer to append
it (commit that on the main branch only if the user agrees). Do not proceed
past an unfixed setup warning without the user's explicit choice.

**File overlaps.** `overlaps` lists files named by tickets with no dependency
path between them. The workflow never runs two of them at once and starts the
next from the merged result, so never add `tk dep` edges for overlaps: a dep
fixes the order permanently and makes the earlier ticket look like it has
dependents, which raises its effort. Warn only about a file named by four or
more tickets, since those take turns. List the `unannotated` tickets: with no
`**Files**:` line, nothing keeps them apart from others.

**Gates.** Find the project's lint, type check, and test commands (CLAUDE.md,
`package.json` scripts, Makefile or justfile, `pyproject.toml`, CI config).
The merge step runs them on every merged result before it commits, so a bad
interaction between two tickets is caught at the merge that caused it. Use
check-only forms: a command that rewrites files (`--fix`, `--write`, `format`
without `--check`, snapshot updates) would leave the integration worktree
dirty. If CLAUDE.md or CI config says the full suite is slow, say so: the
user may drop it from the gates, and the final integration check still runs
everything.

**Large tickets.** Each entry in `large` has more than 6 acceptance criteria.
Big tickets take the most review rounds to settle, and one that hits the
rework cap stalls its `dependents`. List them with their criteria count and
dependents, and offer to split each one: usually a reusable core (an
algorithm, a parser, a model) plus the features on it, or one ticket per
separately testable command or screen. If the user agrees, create the new
tickets with `tk create`, move the criteria across, wire them with `tk dep`,
close the original with a note naming its replacements, and re-run the
planner. A ticket with work already on its `ticket/<id>` branch (a
`--resume`) is usually better finished than split. Proceeding unsplit is the
user's call.

**Integration branch.** Take it from `integration.branch` unless the user
named one; never choose one yourself. When the tickets belong to an epic it
is `epic/<id>`, even in ID mode: an unmerged epic branch is where the code
these tickets touch lives. Only when it is null do you use `run/<STAMP>`
(created from `main` in Phase 2). On `--resume` with a null branch, ask the
user which existing `run/*` branch to reuse (`git branch --list 'run/*'`).
If `integration.behind_main` is above 0, fixes made on `main` since the last
run (a lint config, a broken test) are missing from the branch: offer to
merge `main` in during setup.

**Stale worktrees.** `git worktree list` entries under `.worktrees/run-*`
mean an earlier run did not clean up, or another run is still going (its
`.worktrees/run-<stamp>.json` record lists them). List them; remove one only
if the user says so, without `--force`.

**Findings parent.** Out-of-scope findings go next to the work that produced
them: the epic in epic mode; in ID mode, `shared_parent` if non-null, else a
session epic created in Phase 2. Pre-existing medium and low findings go to
the repo's standing `backlog` epic instead (`tk backlog` prints its id;
setup creates it if missing), so each run's reviews do not refill the epic
with problems it did not cause. When the run is over the backlog epic itself,
it is both.

**Pool size.** `SLOTS = min(8, stats.max_width)`, or `--slots N` when given:
never more slots than the dependency graph can use at once. 8 is how many
concurrent workers (each running its own builds and tests in its worktree) the
owner's machine handles; it is a machine limit, not a property of the run.
The workflow fills slots with the tickets the most others wait on first.

Present the plan:

```
Run: <epic <id>: <title> | <N> tickets>
Tickets: <N> runnable (<K> with AC), <R> ready now · longest chain <L> · max width <W>

  [<id>] <title>  deps: <ids or ->  AC: <yes|no>  <"decided: <answer>" when the owner decided it>
  ...

Excluded:
  [<id>] <title>: <reason>
Left open for you: <decision tickets and what each holds back, or "none">
Warnings: <setup warnings, files shared by 4+ tickets, unannotated tickets, large tickets, stale worktrees, or "none">

Integration branch: <branch> (<integration.reason>; <N> ahead of main, <M> behind)   Slots: <SLOTS>
Gates on every merge: <commands, or "none: integration check only">
Findings parent: <id | new session epic>   Backlog: <id | new, created at setup>
```

Confirm with `AskUserQuestion` (header "Run tickets"): **Proceed
(Recommended)** or **Cancel**. When the branch is behind `main`, ask in the
same call whether to merge `main` in first (recommended). Stop on Cancel.
Apart from the decision notes and tags, nothing has been changed yet.

## Phase 2: Set up

From the repo root:

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
run-tickets-setup --stamp $STAMP --branch <branch> --slots <SLOTS> --tickets <id,id,...> \
  [--merge-main] [--session-epic]
```

Pass `--merge-main` if the user agreed to it, and `--session-epic` in ID mode
with no shared parent. The script creates the branch from `main` if needed,
the integration worktree, the slot worktrees (with `worktree-init`, so
`.worktreelinks` applies), the backlog and session epics, and claims every
ticket with `tk start`. It prints `repoRoot`, `integrationBranch`,
`integrationWorktree`, `slots`, `baseBranch`, `backlogParent`, and
`sessionEpic`: keep them for the Workflow args.

- Exit 2: the branch is checked out in the main repo or another worktree. Ask
  the user to switch away, then run it again.
- Exit 3: merging `main` conflicts (the files are in `mergeMain.files`; the
  merge was aborted). Ask whether to run without merging `main` (re-run
  without `--merge-main`; existing worktrees are reused) or cancel (then
  remove the integration worktree it made).

**Gate baseline.** Run each gate once in the integration worktree, timing it,
with a Bash timeout of 600000 ms. Drop a gate, and tell the user which and
why, when:
- it already fails there, since it would fail every merge;
- it takes more than about 8 minutes, since the merge step's 10-minute
  command limit would cut it off;
- `git status --porcelain --untracked-files=no` is not empty afterwards,
  since it rewrites files. Restore them with `git checkout -- .` and look for
  its check-only form before dropping it.
The integration check at the end still runs everything and separates old
failures from new ones.

## Phase 3: Launch the workflow

First write the run record `<repoRoot>/.worktrees/run-$STAMP.json` with the
Write tool. `/run-status` and `run-tickets-finish` read it:

```json
{ "stamp": "<STAMP>", "launched": "<ISO-8601 local time>", "args": { ...same object as below... } }
```

Then launch:

```
Workflow({
  name: "run-tickets-engine",
  args: {
    repoRoot, integrationBranch, integrationWorktree, slots,   // from run-tickets-setup
    baseBranch, backlogParent,                                 // from run-tickets-setup
    findingsParent: "<id>",                       // epic, shared parent, or sessionEpic
    gates: ["<command>", ...],                    // passed the baseline; [] for none
    tickets: [{ id, title, deps, has_ac, files, decision }, ...]   // from the plan, same order
  }
})
```

`decision` is the owner's answer from Phase 1, verbatim; omit it for tickets
that had no open question. A ticket that depends on a closed decision ticket
(answered by hand or in an earlier run) gets that ticket's answer note too.
On `--resume`, rebuild it from the ticket's `Owner decision` note.

If the name is not found, launch the same thing with
`scriptPath: "~/.claude/workflows/run-tickets-engine.js"` expanded to an absolute path.
Saved workflows are read once per session, so if `run-tickets-engine.js` was edited
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

## Phase 4: Finish

When the completion notification arrives, read `finish.md` in this skill's
directory and follow it in full: it records outcomes, cleans up, and writes the
report. The result's `next` field points there too.
