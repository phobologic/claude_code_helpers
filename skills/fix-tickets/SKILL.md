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

### Findings parent epic

Establish a `FINDINGS_PARENT` epic ID that every finding ticket created by
the quality reviewer (out-of-scope findings + Lows) will be parented to.
Without this, findings get created as orphans and have to be re-parented by
hand after the run.

Inspect the `.parent` field of every input ticket and pick the rule that
applies:

- **All input tickets share the same non-empty parent** (covers both "user
  passed an epic ID" and "user passed a filtered subset of one epic's
  children", e.g. 'all P2s in epic pbp-XXXX plus P3 bugs in that same
  epic'): reuse it. `FINDINGS_PARENT = <that shared parent id>`. No new
  epic is created.

- **Input tickets have mixed or no parents:** create a fresh batch epic to
  catch findings. Do NOT re-parent the input tickets — they may already
  belong to real epics and overwriting those parents would lose meaningful
  grouping:
  ```bash
  STAMP=$(date +%Y%m%d-%H%M%S)
  FINDINGS_PARENT=$(tk create "Fix batch $STAMP" -t epic -p 2 \
    -d "Findings from /fix-tickets run over <N> tickets: <input-ticket-ids>")
  ```

Tell the user which branch you took in one line:

```
Findings parent: <FINDINGS_PARENT> (<reused existing epic | created fresh batch epic>)
```

Record `FINDINGS_PARENT` — you'll pass it to every quality reviewer routing
message so finding tickets land under it automatically.

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
```

Then ask for confirmation via `AskUserQuestion`:

```
AskUserQuestion({
  questions: [{
    question: "Proceed with this wave plan?",
    header: "Fix tickets",
    multiSelect: false,
    options: [
      { label: "Proceed (Recommended)",
        description: "Create the fix-batch integration branch and start Wave 1" },
      { label: "Cancel",
        description: "Stop now — no branches or worktrees are created" }
    ]
  }]
})
```

The user can also pick "Other" to request a different wave grouping or
other adjustments before you proceed. Wait for their answer before
creating anything.

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
  3. Triage findings per your agent instructions:
     - Inline-fixable (Critical/High/Medium scoped to files the ticket touched)
       → list inline in the REWORK verdict; do NOT create tickets for these
     - Out-of-scope findings and all Lows → create tk tickets with
       `--parent <findings-parent>` (the team lead will pass the parent epic
       ID in every routing message)
  4. Report back to the team lead with one of three verdicts:
     - CLEAN — no blocking issues (Lows may still have been ticketed)
     - REWORK — numbered inline list of findings for same-run rework
     - FINDINGS — all blockers were out-of-scope; list the ticketed IDs

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
  1. Check out the ticket branch — resume if it exists, otherwise branch fresh
     from the latest integration state:
     `git checkout fix/<ticket-id> 2>/dev/null || git checkout -b fix/<ticket-id> fix/batch-<stamp>`
     The first form preserves in-progress work if you were recycled mid-ticket;
     the second creates a fresh branch off the latest integration state for new work.
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
- **`assignments_since_spawn[name]`**: count of work messages sent to each
  implementer since (re)spawn. Increment on every dispatch (initial *or*
  rework). Reset to 0 on respawn. Used by implementer recycling — see below.

## Status updates

**Output a status dashboard to the user every time agent or ticket state changes.**
Triggers: ticket dispatched, implementer signals done, quality review verdict
received, ticket merged and closed, wave boundary reached, or an agent appears stuck.

Format (adapt column widths to content):

── TK-42: quality CLEAN ─────────────────────────────────

**Agents**

| Agent | State | Working on | Last heard |
|---|---|---|---|
| implementer-1-&lt;STAMP&gt; | idle | | 14:31:02 |
| implementer-2-&lt;STAMP&gt; | implementing | [TK-44] Fix auth timeout | 14:29:47 |
| quality-reviewer-1 | idle | | 14:30:55 |
| quality-reviewer-2 | reviewing | [TK-43] Add retry header | 14:32:11 |

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

**Timestamping inbound messages.** Every time you quote or summarize a
teammate's message to the user, prefix it with the local clock time you
received it, e.g. `[14:32:05] implementer-2: DONE TK-44 fix/TK-44`. Update
that agent's "Last heard" cell to the same timestamp. This makes silent
stalls visible at a glance.

**Idle-after-STATUS is a stall, not a completion.** Implementers send STATUS
mid-ticket (after reading the ticket, after implementation). `SendMessage` ends
the sender's turn, so an implementer that sends STATUS and then goes idle has
*not* finished its ticket — it has cleanly ended its turn waiting for
acknowledgement. Treat this as an immediate nudge condition, not a normal post-
turn state:

- Track the last message type received from each implementer (`STATUS` vs
  `DONE` vs `BLOCKED`).
- If an implementer goes idle and its last message was `STATUS` (or you have
  dispatched a ticket to it but have never received `DONE` for that ticket),
  immediately `SendMessage` it with `continue working on <ticket-id>`. Do not
  wait for the 5-minute heartbeat sweep below — that cadence is for silent
  death, not for this case.
- Only treat idle as "ready for next assignment" when the last message from
  that implementer was `DONE <ticket-id>` (or it has never been dispatched a
  ticket since spawn).

**Heartbeat cadence.** Don't passively wait forever — agents can die silently
(PostToolUse hook block, stuck shell command, orphaned confirmation prompt).

- If any agent is marked busy and you haven't received a message from anyone
  in ~5 minutes, actively sweep: send a one-line status check via SendMessage
  to each busy agent.
- If a specific agent has been busy on the same task for ~15 minutes without
  a progress message, use `TaskOutput` against its task to inspect what it's
  actually doing. Hook failures and stuck tool calls show up there.
- Report findings in the next dashboard update (the event header for the
  dashboard can be something like `heartbeat sweep`).

## Implementer recycling

Long waves can push individual implementers toward context compaction even
when no wave-boundary respawn is due. Recycle each implementer after a fixed
number of work assignments to keep contexts fresh.

- **`RECYCLE_CAP`** — default `3`. Lower to `2` if your tickets are large.
- **Trigger.** Before sending any work message to an implementer, if
  `assignments_since_spawn[name] >= RECYCLE_CAP`, recycle that implementer
  *before* dispatching the new assignment.

**Recycle procedure (per implementer — clean teardown and rebuild):**

1. Send shutdown to that one implementer:
   ```
   SendMessage({ to: "<name>", message: "type: shutdown_request" })
   ```
2. Wait up to 30 seconds for `SHUTDOWN_ACK <name>`. The implementer is idle
   by definition (it just finished work and is waiting for its next
   assignment), so the ack should arrive quickly. Proceed regardless after
   the timeout.
3. Verify the team lead's CWD is still at `REPO_ROOT` — never `cd` away from
   it during recycle:
   ```bash
   cd <REPO_ROOT> && pwd
   ```
4. Re-spawn using **the exact same `Agent({...})` call as the wave-boundary
   respawn in Step 3.3** — same `name`, same worktree path, same prompt body.
   The worktree persists across the recycle, so do NOT pass
   `isolation: "worktree"`.
5. Wait for the new implementer's `WORKTREE OK` report. Apply the same abort
   logic as Phase 2 — wrong path or `WARNING` aborts the run.
6. Reset `assignments_since_spawn[name] = 0`.
7. Update the dashboard with event header `recycled <name>`.
8. Now dispatch the queued work message to the fresh implementer.

The other implementers, the integration worktree, the quality reviewers, and
any in-flight reviews are untouched — this is a strictly per-implementer
operation. Because the implementer prompt's first step is `git checkout
fix/<id> 2>/dev/null || git checkout -b fix/<id> fix/batch-<stamp>`, a
mid-ticket recycle resumes the existing branch with all in-progress commits
intact.

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
  for context on what was being fixed. Diff the ticket's own changes only
  (not wave N-1 changes already merged to the integration branch) with:
  git diff fix/batch-<stamp>...<branch-name>

  Return one of three verdicts per your agent instructions: CLEAN, REWORK, or
  FINDINGS. Inline-fixable issues (Critical/High/Medium in files the ticket
  already touches) must go in REWORK -- do not create tickets for those.

  For any ticket you DO create (out-of-scope findings and Lows), use
  `--parent <FINDINGS_PARENT>` so findings roll up under the batch epic."
})
```

The reviewer's verdict will be one of three keywords. Route based on the
keyword in the first line of the reply:

- **CLEAN** — merge and close (no blocking issues).
- **REWORK** — send findings back to the implementer for same-run fixes.
- **FINDINGS** — every blocker was out-of-scope and has been pre-ticketed;
  merge and close, logging the new ticket IDs.

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

**When quality reviewer returns REWORK:**

This is the common case when the reviewer finds inline-fixable issues
(Critical, High, or Medium) scoped to files the ticket already touches. No
tickets have been created yet -- the reviewer listed the findings inline in
its verdict message. Forward them verbatim to the implementer and give it
the OUT_OF_SCOPE escape hatch:

```
SendMessage({
  recipient: "<implementer-name>",
  content: "Quality review returned REWORK for <ticket-id>. Fix these in
  fix/<ticket-id> and signal DONE again:

  <paste the numbered finding list from the reviewer's REWORK message verbatim>

  If you believe any individual finding is genuinely out of scope for this
  ticket (requires touching unrelated files, or is about code the ticket
  never modified), reply with one line per such finding:
    OUT_OF_SCOPE <n>: <one-sentence reason>
  and I will convert those to new tickets instead of blocking the merge.
  Fix every finding you do not push back on before signaling DONE."
})
```

When the implementer replies:

- For each `OUT_OF_SCOPE <n>: <reason>` line, create a new tk ticket using
  the same format the quality-reviewer would have used (title from the
  finding, `-p` by the finding's priority word, body with file/line/description/reason),
  and parent it to the batch epic: `tk create ... --parent <FINDINGS_PARENT>`.
  Note these tickets in the source ticket's notes and remove them from the
  blocking set.
- If the implementer then signals `DONE <ticket-id> fix/<ticket-id>`, re-route
  to a quality reviewer (load-balance across reviewers as before). This
  restarts the review cycle for that ticket.
- If the implementer pushes back on *every* finding as OUT_OF_SCOPE without
  recommitting, treat the reply as equivalent to DONE with no changes --
  ticket all the findings, route to the reviewer, and let the reviewer
  decide. In practice this should almost never happen.

Count each REWORK cycle toward the 3-strike limit (see below).

---

**When quality reviewer returns FINDINGS:**

This means every blocking finding was genuinely out of scope and the
reviewer has already created tickets for them. It does NOT block merge.

1. Log the ticket IDs against the source ticket's notes:
   ```bash
   tk add-note <ticket-id> "Quality review: out-of-scope findings ticketed: \
   <finding-ids>"
   ```
2. Proceed to merge exactly as for CLEAN (see above).

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

**If a ticket returns REWORK 3+ times:**

Count every REWORK cycle on the same ticket. After 3 REWORK verdicts,
escalate to the user rather than looping indefinitely:

> `<ticket-id>` has returned REWORK from quality review 3 times. The
> implementer may be stuck or the findings may be ambiguous. Options:
> 1. Review the inline findings and provide guidance
> 2. Skip this ticket and leave it open
> 3. Reassign to a fresh implementer context
> 4. Convert the remaining findings to new tickets and merge anyway

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
  1. Check out the ticket branch — resume if it exists, otherwise branch fresh
     from the latest integration state:
     \`git checkout fix/<ticket-id> 2>/dev/null || git checkout -b fix/<ticket-id> fix/batch-<stamp>\`
     The first form preserves in-progress work if you were recycled mid-ticket;
     the second creates a fresh branch off the latest integration state for new work.
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
  Review produced findings:      tk triage --epic <FINDINGS_PARENT> --sort priority,confidence
```

Findings carry a priority (Critical/High/Medium/Low → `-p 0..3`) and an
epistemic confidence score (0–100) — see the reviewer agents for the rubric.
`tk triage --sort priority,confidence` is the canonical way to walk them:
highest priority first, then highest confidence within each priority band.

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

**Implementer unresponsive.** Follow the heartbeat cadence (see "Status
updates"): SendMessage status check after ~5 min of silence, `TaskOutput`
inspection after ~15 min of no progress. Common silent-death modes are
PostToolUse hook blocks, stuck shell commands, and orphaned confirmation
prompts — all visible via `TaskOutput`. If the agent is truly stuck, tell
the user what you found and suggest spawning a replacement pointed at the
same task.

**All tickets in a wave fail quality review simultaneously.** Don't hold up the
quality reviewer queue — process each ticket's review cycle independently. Other
tickets in the same wave that pass review should merge without waiting.

**Wave has only 1 ticket.** Still valid — just no parallelism in that wave.

**User wants to stop mid-batch.** Send `shutdown_request` to all teammates,
TeamDelete. In-progress tickets remain claimable. Resume by running `/fix-tickets`
with the remaining open ticket IDs.
