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

Mark all remaining tickets as in-progress immediately, before planning or confirmation,
so concurrent runs cannot claim the same tickets:

```bash
tk start <ticket-id>
# repeat for each ticket
```

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

### Step 2.1: Integration branch and repo root

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
REPO_ROOT=$(pwd)
git checkout -b fix/batch-$STAMP main
git checkout main
worktree-init fix-batch-$STAMP $REPO_ROOT fix/batch-$STAMP
```

Record `STAMP` and `REPO_ROOT` — you'll need them throughout. The integration
worktree at `.worktrees/fix-batch-$STAMP` is where all merges happen, keeping
the main repo on `main` so quality reviewers can read from it safely.

### Step 2.2: Pre-create implementer worktrees

Create worktrees for all implementers now, before spawning any agents. Do not rely
on the `isolation: "worktree"` parameter to create them — that hook only fires
reliably in the main session, not from sub-agent contexts.

Use `worktree-init` (not raw `git worktree add`) — it applies `.worktreelinks` and
`.worktreeinclude` setup so shared state (e.g. `.tickets/`) is available in each
implementer worktree.

```bash
# Create one worktree per implementer (min(4, total_ticket_count))
worktree-init implementer-1-$STAMP $REPO_ROOT
worktree-init implementer-2-$STAMP $REPO_ROOT
# ... repeat for each implementer up to the cap
```

Verify each was created: `ls .worktrees/` should show all implementer dirs.

### Step 2.3: Create the team

```
TeamCreate({
  team_name: "fix-<stamp>",
  description: "Fix batch: <N> tickets"
})
```

### Step 2.4: Spawn quality reviewers and implementers

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
  reported results for the current one. When you receive a message containing
  'type: shutdown_request', reply with SHUTDOWN_ACK <your-name> then stop."
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
  name: "implementer-<N>-<STAMP>",
  isolation: "worktree",
  prompt: "You are implementer-<N>-<STAMP> on a fix team.

  WORKTREE: <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP>

  Before doing anything else, run this single Bash call to set your CWD
  and verify isolation:
  ```
  cd <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
  ```
  Report the pwd output and result to the team lead via SendMessage, then wait.

  All tool calls MUST target your worktree, not the main repo:
  - Bash: your CWD is already set — just run commands directly
  - Read/Edit: absolute paths starting with <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP>/
  - Glob/Grep: pass path=<REPO_ROOT>/.worktrees/implementer-<N>-<STAMP>
  Never reference <REPO_ROOT> without the .worktrees/implementer-<N>-<STAMP> suffix.

  Git: your CWD is already the worktree — always use plain `git` with no -C flag.
  Never use `git -C <path>` in implementer code; that is reserved for the team lead
  when it operates outside its own working directory.

  For each ticket assignment:
  1. Run `git checkout -B fix/<ticket-id> fix/batch-<stamp>` to branch from the
     latest integration state (this ensures wave N+1 builds on wave N's merged code)
  2. Run `tk show <ticket-id>` for full context
  3. Send STATUS to team lead: 'STATUS <name>: read <ticket-id>, starting implementation'
  4. Implement the fix
  5. Send STATUS to team lead: 'STATUS <name>: implementation done on <ticket-id>, running tests'
  6. Run tests from your worktree
  7. Commit to fix/<ticket-id>
  8. Message the team lead: DONE <ticket-id> fix/<ticket-id>

  Then wait for your next assignment. When you receive a message containing
  'type: shutdown_request', reply with SHUTDOWN_ACK <name> then stop."
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

## Status updates

**Output a status dashboard to the user every time agent or ticket state changes.**
Triggers: ticket dispatched, implementer signals done, quality review verdict
received, ticket merged and closed, wave boundary reached, or an agent appears stuck.

Format (adapt column widths to content):

── TK-42: quality CLEAN ─────────────────────────────────

**Agents**

| Agent | State | Working on |
|---|---|---|
| implementer-1-&lt;STAMP&gt; | idle | |
| implementer-2-&lt;STAMP&gt; | implementing | [TK-44] Fix auth timeout |
| quality-reviewer-1 | idle | |
| quality-reviewer-2 | reviewing | [TK-43] Add retry header |

**Wave 1** (active)

| Ticket | Status | Notes |
|---|---|---|
| [TK-42] Fix null check | ✓ merged | |
| [TK-43] Add retry header | quality review | |
| [TK-44] Fix auth timeout | implementing | |

**Wave 2** (pending)

| Ticket | Status | Notes |
|---|---|---|
| [TK-45] Update schema | queued | |
| [TK-46] Fix migration | queued | |

Progress: 1/5 closed · Wave 1: 1/3 merged

─────────────────────────────────────────────────────────

The one-line header after `──` describes the event that triggered this update.

Keep it concise — no prose, just the tables. For minor updates you may omit
unchanged tables (e.g. if only an agent state changed, show just the Agents
table with the event header).

If an implementer hasn't signaled completion in a while, send a status check
via SendMessage and note it in the dashboard.

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
First `cd <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP> && git checkout -B fix/<ticket-id> fix/batch-<stamp>` to branch from integration.
Then `tk show <ticket-id>` for full context.
Implement the fix, run tests, commit to fix/<ticket-id>, then message the team lead:
DONE <ticket-id> fix/<ticket-id>"
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
  for context on what was being fixed. Diff: git diff main...<branch-name>"
})
```

---

**When quality reviewer returns CLEAN:**

1. Merge to integration branch using `git -C` — never `cd` into the
   integration worktree, as that contaminates the team lead's CWD and
   breaks worktree isolation for agents spawned afterward:
   ```bash
   git -C .worktrees/fix-batch-<stamp> merge fix/<ticket-id> --no-ff -m "Fix <ticket-id>: <title>"
   ```

2. Close the ticket:
   ```bash
   tk add-note <ticket-id> "Implemented and merged. Quality review clean. \
   Non-blocking findings: <ids or 'none'>"
   tk close <ticket-id>
   ```

3. If there are remaining unassigned tickets **in this wave**, dispatch the next one
   to this now-free implementer. Do NOT dispatch tickets from future waves — those
   start only after the wave boundary restart. Do NOT spawn a new implementer:
   ```
   SendMessage({
     to: "<implementer-name>",
     message: "ticket: <next-ticket-id>
   title: <title>
   First `cd <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP> && git checkout -B fix/<next-ticket-id> fix/batch-<stamp>` to branch from
   integration. Then `tk show <next-ticket-id>` for full context.
   Implement the fix, run tests, commit to fix/<next-ticket-id>, then message the
   team lead: DONE <next-ticket-id> fix/<next-ticket-id>"
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
  In the integration worktree at .worktrees/fix-batch-<stamp>, merge your
  branch, resolve conflicts, and commit. Signal DONE with fix/<ticket-id>
  when ready — this will go through quality review again since the resolved
  code may differ."
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

The wave is complete when **all** its tickets are closed and merged **and** all agents
are idle — including any in-flight quality reviews. A ticket stuck in a
findings-rework loop is not closed, so it holds the wave open.

**Restart all agents at every wave boundary** to clear accumulated context and prevent
compaction on long runs. Worktrees persist between waves — only agent contexts reset.

Log it:

```
Wave <N> complete: <M> tickets merged to fix/batch-<stamp>
Remaining waves: <W-N> — restarting agents for clean context
```

**1. Shutdown all agents.** Send shutdown to each and wait up to 30 seconds for
`SHUTDOWN_ACK <name>` from each. Proceed after the timeout regardless — agents
should be idle at this point.

```
SendMessage({ to: "quality-reviewer-1",    message: "type: shutdown_request" })
SendMessage({ to: "quality-reviewer-2",    message: "type: shutdown_request" })
SendMessage({ to: "implementer-1-<STAMP>", message: "type: shutdown_request" })
# ... all implementers
```

**2. Re-spawn quality reviewers** (no worktrees — pure context reset). Reuse the
same names so dispatch routing doesn't change:

```
Agent({ subagent_type: "quality-reviewer", team_name: "fix-<stamp>",
        name: "quality-reviewer-1", prompt: "<same as Phase 2.4>" })
Agent({ subagent_type: "quality-reviewer", team_name: "fix-<stamp>",
        name: "quality-reviewer-2", prompt: "<same as Phase 2.4>" })
```

**3. Reset CWD and re-spawn implementers.** Before spawning, verify the team
lead is at `REPO_ROOT` — merge operations may have drifted the CWD:

```bash
cd <REPO_ROOT> && pwd
```

Spawn only `min(cap, next_wave_ticket_count)` — no idle agents. Reuse the same
names and worktree paths. Do NOT use `isolation: "worktree"` — the worktrees
already exist, and the isolation parameter creates a new worktree via raw
`git worktree add`, bypassing the `worktree-init` setup.

Write the full prompt — do not abbreviate or reference Phase 2.4:

```
Agent({
  subagent_type: "implementer",
  team_name: "fix-<stamp>",
  name: "implementer-<N>-<STAMP>",
  prompt: "You are implementer-<N>-<STAMP> on a fix team.

  WORKTREE: <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP>

  Before doing anything else, run this single Bash call to set your CWD
  and verify isolation:
  \`\`\`
  cd <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
  \`\`\`
  Report the pwd output and result to the team lead via SendMessage, then wait.

  All tool calls MUST target your worktree, not the main repo:
  - Bash: your CWD is already set — just run commands directly
  - Read/Edit: absolute paths starting with <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP>/
  - Glob/Grep: pass path=<REPO_ROOT>/.worktrees/implementer-<N>-<STAMP>
  Never reference <REPO_ROOT> without the .worktrees/implementer-<N>-<STAMP> suffix.

  Git: your CWD is already the worktree — always use plain \`git\` with no -C flag.
  Never use \`git -C <path>\` in implementer code; that is reserved for the team lead
  when it operates outside its own working directory.

  For each ticket assignment:
  1. Run \`git checkout -B fix/<ticket-id> fix/batch-<stamp>\` to branch from the
     latest integration state (this ensures wave N+1 builds on wave N's merged code)
  2. Run \`tk show <ticket-id>\` for full context
  3. Send STATUS to team lead: 'STATUS <name>: read <ticket-id>, starting implementation'
  4. Implement the fix
  5. Send STATUS to team lead: 'STATUS <name>: implementation done on <ticket-id>, running tests'
  6. Run tests from your worktree
  7. Commit to fix/<ticket-id>
  8. Message the team lead: DONE <ticket-id> fix/<ticket-id>

  Then wait for your next assignment. When you receive a message containing
  'type: shutdown_request', reply with SHUTDOWN_ACK <name> then stop."
})
# ... repeat for each needed implementer
```

**4. Wait for `WORKTREE OK`** from all re-spawned implementers. Each must
report the `pwd` output showing their worktree path. Apply the same abort
logic as Phase 2 — if any report `WARNING` or a wrong path, stop.

Proceed to Step 3.1 and dispatch the next wave's tickets.

**Known limitation:** agent restarts clear context between waves but do not protect
against compaction during a single long-running ticket. If a ticket is complex
enough to trigger compaction mid-implementation, consider splitting it.

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
SendMessage({ to: "quality-reviewer-1",    message: "type: shutdown_request" })
SendMessage({ to: "quality-reviewer-2",    message: "type: shutdown_request" })
SendMessage({ to: "implementer-1-<STAMP>", message: "type: shutdown_request" })
# ... all implementers
```

Clean up worktrees:
```bash
for N in 1 2 3 4; do  # adjust to match implementer count
  git worktree remove .worktrees/implementer-$N-<STAMP> --force 2>/dev/null || true
done
git worktree remove .worktrees/fix-batch-<stamp> --force 2>/dev/null || true
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
