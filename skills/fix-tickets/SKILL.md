---
name: fix-tickets
description: >
  Implement a set of tk tickets in parallel using an agent team. Analyzes tickets
  for file-level conflicts, groups into minimum-wave batches, and runs each wave
  with parallel implementers validated by a quality reviewer. Designed for
  multi-review fix batches where tickets don't have formal acceptance criteria.
  Use when the user says "fix these tickets", "batch fix", "run these tickets in
  parallel", or similar.
argument-hint: "<ticket-id> [ticket-id ...] | <epic-id>"
---

# Fix Tickets

You are the team lead. You orchestrate parallel implementation of a set of tickets.
You never write code, never review code, never make judgment calls about implementation.
You plan, dispatch, route, and manage lifecycle.

## Phase 0 — Load tickets

Parse `$ARGUMENTS`. Accept:
- One or more ticket IDs: `fix-tickets 42 43 44 45`
- A single epic ID: pulls all non-closed, non-in-progress children

If no arguments, show usage and stop.

Load all tickets:

```bash
tk show-multi <ids>
# or, for an epic:
tk query '.parent == "<epic-id>"'
```

Filter out any tickets with status `closed` or `in-progress`. If nothing remains,
tell the user and stop.

## Phase 1 — Plan waves

Read every ticket's title, description, and notes. Reason about which tickets
are likely to touch overlapping files or code areas.

**Signals that two tickets conflict** (put them in different waves):
- Both mention the same filename, class, or function by name
- Both touch the same subsystem (e.g., both in auth middleware, both in the same
  data model, both in the same config file)
- One ticket's fix is logically prerequisite to another

**Safe to parallelize** (same wave):
- Clearly different subsystems, packages, or layers
- One is a test fix in an isolated test file, one is a logic fix elsewhere
- Ticket descriptions show no overlapping file or module references

**Bias heavily toward parallelism.** Put tickets in the same wave unless you have
a concrete reason they'd conflict. Merge conflicts are recoverable; unnecessary
serialization wastes time.

Present the grouping to the user:

```
N tickets → W wave(s)

Wave 1 (parallel — <M> implementers):
  [<id>] <title>
  [<id>] <title>
  [<id>] <title>

Wave 2 (starts after Wave 1 merges):
  [<id>] <title>

Rationale: Wave 2 serialized because both tickets likely touch <shared area>.

Proceed? [y/N]
```

Wait for confirmation before creating anything.

## Phase 2 — Create team infrastructure

### Step 2.1: Integration branch

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
git checkout -b fix/batch-$STAMP main
git checkout main
```

Record the integration branch name — you'll need it throughout.

### Step 2.2: Create the team

```
TeamCreate({
  team_name: "fix-<stamp>",
  description: "Fix batch: <N> tickets"
})
```

### Step 2.3: Spawn quality reviewers and implementers

Spawn two quality reviewers and up to 4 implementers. All are reused across every
wave — never spawn additional agents later.

**Quality reviewers** load-balance review work across all waves:

```
Agent({
  subagent_type: "quality-reviewer",
  team_name: "fix-<stamp>",
  name: "quality-reviewer-1",
  prompt: "You are quality-reviewer-1 on a fix team. Wait for the team lead to
  route tickets to you via SendMessage. For each ticket routed:

  1. Read `tk show <ticket-id>` to understand what was being fixed
  2. Read the diff on the branch provided
  3. Create tk tickets for any Critical, High, or Medium findings (standalone, no
     parent required)
  4. Report back to the team lead with one of:
     - CLEAN — no critical or high findings (note any medium/low ticket IDs created)
     - FINDINGS — list each critical/high finding ticket ID and its title

  Process tickets in the order received. Do not start the next review until you have
  reported results for the current one. When you receive a shutdown message, stop."
})

Agent({
  subagent_type: "quality-reviewer",
  team_name: "fix-<stamp>",
  name: "quality-reviewer-2",
  // same prompt as quality-reviewer-1
})
```

**Implementers** — spawn `min(4, total_ticket_count)` now. They wait for assignments
via `SendMessage` and are reused across all waves:

```
Agent({
  subagent_type: "implementer",
  team_name: "fix-<stamp>",
  name: "implementer-<N>",
  isolation: "worktree",
  prompt: "You are implementer-<N> on a fix team.

  First, verify your isolation before doing anything else:
    [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: in main repo'
  Report the result to the team lead immediately via SendMessage, then wait for
  ticket assignments.

  For each assignment:

  1. Run `tk show <ticket-id>` for full context — these are typically code quality
     or bug findings from a code review
  2. Implement the fix in your worktree
  3. Run tests from $PWD — never `cd` to another directory
  4. Commit to a branch named fix/<ticket-id>
  5. Message the team lead: DONE <ticket-id> fix/<ticket-id>

  Worktree rules: $PWD is the project root. Never use absolute paths like
  /Users/.../project/ in any command. Use relative paths and the Glob/Grep
  tools instead of bash find/grep.

  Then wait for your next assignment. When you receive a shutdown message, stop."
})
```

After spawning all implementers, wait for their isolation check results. Each
implementer will report back `WORKTREE OK` or `WARNING: in main repo`.

- If **all report `WORKTREE OK`**: proceed to Phase 3.
- If **any report `WARNING: in main repo`**: stop immediately and tell the user:
  > Worktree isolation failed — implementers are running in the main repo.
  > This will cause parallel agents to conflict. Aborting.
  Then shut down all teammates and call `TeamDelete()`.

Track implementer state throughout the run:
- **idle**: waiting for work (all start idle)
- **busy**: working on a ticket (map: implementer-name → ticket-id)

## Phase 3 — Execute waves

Repeat for each wave in order. A wave is complete only when all its tickets are closed
and merged into the integration branch.

### Step 3.1: Dispatch tickets for this wave

Do NOT spawn new implementers. Dispatch tickets to existing idle implementers via
`SendMessage`. Cap in-flight work at 4 tickets at a time; queue the rest and dispatch
as implementers free up.

For each ticket to dispatch (up to the number of idle implementers):

```
SendMessage({
  to: "<idle-implementer-name>",
  message: "ticket: <ticket-id>
title: <title>
Run `tk show <ticket-id>` for full context. Implement the fix, run tests, commit to
fix/<ticket-id>, then message the team lead: DONE <ticket-id> fix/<ticket-id>"
})
```

Mark that implementer as busy. Announce to the user:

```
Wave <N>: dispatching <M> tickets to implementers: <ticket-ids>
```

### Step 3.2: Validation loop

As implementers complete and send `DONE <ticket-id> <branch>`:

**Immediately route to a quality reviewer** — don't wait for other implementers
in the wave. Start review the moment any ticket is ready.

Route to whichever reviewer is currently idle. If both are idle, prefer
`quality-reviewer-1`. If both are busy, queue the ticket and send it to
whichever reviewer reports back first.

```
SendMessage({
  recipient: "quality-reviewer-1",  // or quality-reviewer-2
  content: "Review <ticket-id> on branch <branch-name>. Run `tk show <ticket-id>`
  for context on what was being fixed."
})
```

---

**When quality reviewer returns CLEAN:**

1. Merge to integration branch:
   ```bash
   git checkout fix/batch-<stamp>
   git merge fix/<ticket-id> --no-ff -m "Fix <ticket-id>: <title>"
   git checkout main
   ```

2. Close the ticket:
   ```bash
   tk add-note <ticket-id> "Implemented and merged. Quality review clean. \
   Non-blocking findings: <ids or 'none'>"
   tk close <ticket-id>
   ```

3. If there are remaining unassigned tickets in this wave (or queued from a
   future wave), dispatch the next one to this now-free implementer. Do NOT
   spawn a new implementer — send the assignment to the existing one:
   ```
   SendMessage({
     to: "<implementer-name>",
     message: "ticket: <next-ticket-id>
   title: <title>
   Run `tk show <next-ticket-id>` for full context. Implement the fix, run tests,
   commit to fix/<next-ticket-id>, then message the team lead:
   DONE <next-ticket-id> fix/<next-ticket-id>"
   })
   ```
   Mark that implementer busy again.

4. If there are queued tickets waiting for review, send the next one to this
   now-free reviewer.

---

**When quality reviewer returns FINDINGS (critical or high):**

Forward to the implementer:
```
SendMessage({
  recipient: "<implementer-name>",
  content: "Quality review found issues in <ticket-id> that must be fixed:

  Critical/High (blocking):
  - [<finding-id>] <title>
  - [<finding-id>] <title>

  Run `tk show <finding-id>` for details. Fix the issues, recommit to
  fix/<ticket-id>, and signal DONE again. This will go through quality review again."
})
```

Once the implementer signals DONE again, re-route to quality reviewer (restarting
the review cycle). When the ticket eventually passes and merges, close any
critical/high finding tickets that were resolved:
```bash
tk close <finding-id>
tk add-note <finding-id> "Fixed as part of <ticket-id>"
```

---

**When a merge produces conflicts:**

```
SendMessage({
  recipient: "<implementer-name>",
  content: "Merge conflict integrating <ticket-id> into fix/batch-<stamp>.
  Check out fix/batch-<stamp>, merge your branch, resolve conflicts, and commit.
  Signal DONE with fix/<ticket-id> when ready — this will go through quality
  review again since the resolved code may differ."
})
```

---

**If a ticket fails quality review 3+ times:**

Escalate to the user rather than looping indefinitely:

> `<ticket-id>` has failed quality review 3 times. The implementer may be stuck
> or the finding may be ambiguous. Options:
> 1. Review the finding tickets and provide guidance
> 2. Skip this ticket and leave it open
> 3. Reassign to a fresh implementer context

### Step 3.3: Wave boundary

The wave is complete when **all** its tickets are closed and merged. Log it:

```
Wave <N> complete: <M> tickets merged to fix/batch-<stamp>
Remaining waves: <W-N>
```

**Do NOT spawn new implementers for the next wave.** The same implementer pool
is reused for the entire batch. All implementers are currently idle at this point —
proceed to Step 3.1 and dispatch the next wave's tickets to them via `SendMessage`.

## Phase 4 — Completion

When all waves are done and all tickets are closed:

```
Batch complete. <N> tickets implemented and merged.

Integration branch: fix/batch-<stamp>

Closed:
  [<id>] <title>
  ...

Non-blocking findings (tracked as open tickets):
  [<finding-id>] <title> — medium/low
  ...

Next steps:
  Review the full batch diff:    git diff main fix/batch-<stamp>
  Deep review (optional):        /multi-review -- fix/batch-<stamp>
  Merge to main:                 git checkout main && git merge fix/batch-<stamp> --no-ff
```

Shut down all teammates:
```
SendMessage({ recipient: "quality-reviewer-1", content: "Batch complete. Shutting down." })
SendMessage({ recipient: "quality-reviewer-2", content: "Batch complete. Shutting down." })
SendMessage({ recipient: "implementer-1",       content: "Batch complete. Shutting down." })
# ... all implementers
```

Then:
```
TeamDelete()
```

## Edge Cases

**Implementer unresponsive.** After a reasonable wait, send a status check via
SendMessage. If no response, inform the user and suggest spawning a replacement
implementer pointed at the same task.

**All tickets in a wave fail quality review simultaneously.** Don't hold up the
quality reviewer queue — process each ticket's review cycle independently. Other
tickets in the same wave that pass review should merge without waiting.

**Wave has only 1 ticket.** Still valid — just no parallelism in that wave.

**User wants to stop mid-batch.** Send `shutdown_request` to all teammates,
TeamDelete. In-progress tickets remain claimable. Resume by running `/fix-tickets`
with the remaining open ticket IDs.
