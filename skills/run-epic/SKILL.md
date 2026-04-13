---
name: run-epic
description: >
  Execute a tk epic using an agent team. Creates implementer, AC verifier, and
  quality reviewer teammates, dispatches unblocked tickets for parallel
  implementation, and manages the validation loop. Use when the user says
  "run epic", "execute epic", "start working on the epic", or similar.
argument-hint: "<epic-id>"
---

# Run Epic

You are the team lead. You orchestrate the execution of a tk epic using an agent
team. You never implement, never review, never make judgment calls about code.
You dispatch work, route validation results, and manage the lifecycle.

## Phase 0 -- Parse arguments and load epic

If `$ARGUMENTS` is empty, ask the user for an epic ID.

Load the epic and its children:

```bash
tk show <epic-id>
tk query '.parent == "<epic-id>"'
```

Verify this is actually an epic (type == "epic"). If not, tell the user and
stop.

Check for child tickets. If there are none, tell the user the epic has no
tickets and stop.

Mark all non-closed child tickets as in-progress immediately, so concurrent
runs cannot claim the same tickets:

```bash
tk start <ticket-id>
# repeat for each non-closed child ticket
```

Present a summary to the user:

```
Epic: <title>
Tickets: N total, M ready (unblocked), K in-progress, J closed

Ready tickets:
  [<id>] <title>
  [<id>] <title>
  ...

Blocked tickets:
  [<id>] <title> (blocked by: <dep-ids>)
  ...
```

Then ask for confirmation via `AskUserQuestion`:

```
AskUserQuestion({
  questions: [{
    question: "Proceed with team execution for this epic?",
    header: "Run epic",
    multiSelect: false,
    options: [
      { label: "Proceed (Recommended)",
        description: "Create the agent team and start executing ready tickets" },
      { label: "Cancel",
        description: "Stop now — no team is created, no tickets are claimed" }
    ]
  }]
})
```

The user can also pick "Other" to request plan adjustments before you
proceed. Wait for their answer before creating the team.

## Phase 1 -- Create the agent team

Determine the number of implementers based on ready tickets. Use at most one
implementer per ready ticket. For epics with many ready tickets, cap at a
reasonable number (3-4 implementers is usually a good ceiling -- more agents
means more coordination overhead and token cost).

Tell the user what you're about to create:

```
Creating agent team for epic <epic-id>:
  - <N> implementer(s) (opus, worktree isolation)
  - 1 AC verifier (sonnet, read-only)
  - 1 quality reviewer (sonnet, read-only)

Tip: Press Shift+Tab to enable delegate mode so the lead stays focused
on orchestration. Use Shift+Down to cycle through teammates.
```

### Step 1.1: Create integration branch and capture repo root

Create a branch where validated ticket branches will be merged. This keeps
all epic work off main until the full epic is reviewed.

```bash
REPO_ROOT=$(pwd)
STAMP=$(date +%s | tail -c 7)  # short session discriminator for unique worktree names
git checkout -b epic/<epic-id> main
git checkout main  # return to main, implementers branch from here
```

Record `REPO_ROOT` and `STAMP` — you'll use them in worktree paths for implementer prompts.

### Step 1.2: Pre-create implementer worktrees

Create worktrees for all implementers now, before spawning any agents. Do not rely
on the `isolation: "worktree"` parameter — that hook only fires reliably in the main
session, not from sub-agent contexts.

Use `worktree-init` (not raw `git worktree add`) — it applies `.worktreelinks` and
`.worktreeinclude` setup so shared state (e.g. `.tickets/`) is available in each
implementer worktree.

```bash
# Create one worktree per implementer (min(3-4, ready_ticket_count))
worktree-init implementer-1-$STAMP $REPO_ROOT
worktree-init implementer-2-$STAMP $REPO_ROOT
# ... repeat for each implementer
```

Verify each was created: `ls .worktrees/` should show all implementer dirs.

### Step 1.3: Create the team

Call TeamCreate to initialize the team namespace:

```
TeamCreate({
  team_name: "epic-<epic-id>",
  description: "Team executing epic <epic-id>: <epic title>"
})
```

### Step 1.4: Create initial tasks

Call TaskCreate for each ready ticket (up to the implementer cap):

```
TaskCreate({
  subject: "Implement <ticket-id>: <ticket title>",
  description: "Run `tk show <ticket-id>` for full context including
  description and acceptance criteria. Implement, write tests, ensure
  tests pass, commit, then message the team lead when done."
})
```

### Step 1.5: Spawn teammates

Spawn each teammate using the Agent tool with the `team_name` parameter so
they join the team (not as standalone background agents). The `name` parameter
gives each teammate a readable identifier.

**Implementers** (one per ready ticket, up to cap):

```
Agent({
  prompt: "You are an implementer on a team.

  WORKTREE: <REPO_ROOT>/.worktrees/implementer-1-<STAMP>

  Before doing anything else, run this single Bash call to set your CWD
  and verify isolation:
  ```
  cd <REPO_ROOT>/.worktrees/implementer-1-<STAMP> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
  ```
  Report the pwd output and result to the team lead via SendMessage.

  All tool calls MUST target your worktree, not the main repo:
  - Bash: your CWD is already set — just run commands directly
  - Read/Edit: absolute paths starting with <REPO_ROOT>/.worktrees/implementer-1-<STAMP>/
  - Glob/Grep: pass path=<REPO_ROOT>/.worktrees/implementer-1-<STAMP>
  Never reference <REPO_ROOT> without the .worktrees/implementer-1-<STAMP> suffix.

  Git: your CWD is already the worktree — always use plain `git` with no -C flag.
  Never use `git -C <path>` in implementer code; that is reserved for the team lead
  when it operates outside its own working directory.

  Then wait for the team lead to assign you a ticket via SendMessage. Do NOT
  claim tickets from the task list — the team lead routes all work.

  For each ticket assignment:
  1. Check out the ticket branch — resume if it exists, otherwise branch fresh
     from the latest integration state:
     `git checkout ticket/<ticket-id> 2>/dev/null || git checkout -b ticket/<ticket-id> epic/<epic-id>`
     The first form preserves in-progress work if you were recycled mid-ticket;
     the second creates a fresh branch off the latest integration state for new work.
  2. Run `tk show <ticket-id>` for full context
  3. Send STATUS to team lead: 'STATUS <name>: read <ticket-id>, starting implementation'
  4. Implement the fix
  5. Send STATUS to team lead: 'STATUS <name>: implementation done on <ticket-id>, running tests'
  6. Run tests from your worktree
  7. Commit to ticket/<ticket-id>
  8. Message the team lead: DONE <ticket-id> ticket/<ticket-id>

  Then wait for your next assignment. When you receive a message containing
  'type: shutdown_request', reply with SHUTDOWN_ACK <name> then stop.",
  subagent_type: "implementer",
  team_name: "epic-<epic-id>",
  name: "implementer-1-<STAMP>",
  isolation: "worktree"
})
```

Repeat for implementer-2-<STAMP>, implementer-3-<STAMP>, etc.

**AC verifier:**

```
Agent({
  prompt: "You are the AC verifier on a team. Wait for the team lead to
  send you tickets to verify. Do not claim tasks from the task list.
  When you receive a message containing 'type: shutdown_request', reply with SHUTDOWN_ACK ac-verifier then stop.",
  subagent_type: "ac-verifier",
  team_name: "epic-<epic-id>",
  name: "ac-verifier"
})
```

**Quality reviewer:**

```
Agent({
  prompt: "You are the quality reviewer on a team. Wait for the team lead
  to send you tickets to review. Do not claim tasks from the task list.
  When you receive a message containing 'type: shutdown_request', reply with SHUTDOWN_ACK quality-reviewer then stop.",
  subagent_type: "quality-reviewer",
  team_name: "epic-<epic-id>",
  name: "quality-reviewer"
})
```

## Phase 2 -- Verify worktree isolation

After spawning all implementers, wait for their isolation check results. Each
implementer will report back `WORKTREE OK` or `WARNING: in main repo`.

- If **all report `WORKTREE OK`**: proceed to Phase 3.
- If **any report `WARNING: in main repo`**: stop immediately and tell the user:
  > Worktree isolation failed — implementers are running in the main repo.
  > This will cause parallel agents to conflict. Aborting.
  Then shut down all teammates and call `TeamDelete()`.

The AC verifier and quality reviewer should be idle, waiting for messages. If
any teammate failed to spawn entirely, retry the Agent call. If repeated
failures, inform the user.

## Status updates

**Output a status dashboard to the user every time agent or ticket state changes.**
Triggers: ticket dispatched, implementer signals done, AC verdict received,
quality review verdict received, ticket merged and closed, new ticket unblocked,
or an agent appears stuck.

Format (adapt column widths to content):

── TK-09: AC PASS ──────────────────────────────────────

**Agents**

| Agent | State | Working on | Last heard |
|---|---|---|---|
| implementer-1-&lt;STAMP&gt; | implementing | [TK-12] Add login endpoint | 14:29:47 |
| implementer-2-&lt;STAMP&gt; | idle | | 14:30:55 |
| ac-verifier | idle | | 14:31:02 |
| quality-reviewer | reviewing | [TK-09] Fix rate limiter | 14:32:11 |

**Tickets**

| Ticket | Status | Notes |
|---|---|---|
| [TK-09] Fix rate limiter | quality review | AC pass #1 |
| [TK-12] Add login endpoint | implementing | |
| [TK-15] Add logout endpoint | blocked | waiting: TK-12 |
| [TK-07] Update README | ✓ merged | |

Progress: 1/4 closed

─────────────────────────────────────────────────────────

The one-line header after `──` describes the event that triggered this update.

Keep it concise — no prose, just the tables. For minor updates you may omit
unchanged tables (e.g. if only an agent state changed, show just the Agents
table with the event header).

**Timestamping inbound messages.** Every time you quote or summarize a
teammate's message to the user, prefix it with the local clock time you
received it, e.g. `[14:32:05] implementer-2: DONE TK-12 feat/TK-12`. Update
that agent's "Last heard" cell to the same timestamp. This makes silent
stalls visible at a glance.

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

Long-running tickets — especially those that go through several findings or
AC-fail rework cycles — can push an implementer toward context compaction
mid-ticket. Recycle each implementer after a fixed number of work
assignments to keep contexts fresh.

Track per implementer:

- **`assignments_since_spawn[name]`** — increment by 1 every time you send a
  work message to that implementer (initial dispatch *or* AC-fail rework
  *or* findings rework). Reset to 0 on (re)spawn.
- **`RECYCLE_CAP`** — default `3`. Lower to `2` if your tickets are large.

**Trigger.** Before sending any work message to an implementer, if
`assignments_since_spawn[name] >= RECYCLE_CAP`, recycle that implementer
*before* dispatching the new assignment. (This typically fires mid-ticket
during rework cycles, since each implementer does at most one fresh ticket
per wave.)

**Recycle procedure (per implementer — clean teardown and rebuild):**

1. Send shutdown to that one implementer:
   ```
   SendMessage({ to: "<name>", message: "type: shutdown_request" })
   ```
2. Wait up to 30 seconds for `SHUTDOWN_ACK <name>`. The implementer is idle
   by definition (it just sent something to the lead and is waiting for the
   next instruction), so the ack should arrive quickly. Proceed regardless
   after the timeout.
3. Verify the team lead's CWD is still at `REPO_ROOT` — never `cd` away
   from it during recycle:
   ```bash
   cd <REPO_ROOT> && pwd
   ```
4. Re-spawn using **the exact same `Agent({...})` call as the wave-boundary
   respawn** — same `name`, same worktree path, same prompt body. The
   worktree persists across the recycle, so do NOT pass
   `isolation: "worktree"`.
5. Wait for the new implementer's `WORKTREE OK` report. Apply the same
   abort logic as Phase 2 — wrong path or `WARNING` aborts the run.
6. Reset `assignments_since_spawn[name] = 0`.
7. Update the dashboard with event header `recycled <name>`.
8. Now dispatch the queued work message to the fresh implementer. If the
   recycle happened mid-ticket, that message should be the rework
   instruction — the new implementer's prompt resumes the existing
   `ticket/<id>` branch automatically.

The other implementers, the integration branch, the AC verifier, the
quality reviewer, and any in-flight reviews are untouched — this is a
strictly per-implementer operation. Because the implementer prompt's first
step is `git checkout ticket/<id> 2>/dev/null || git checkout -b
ticket/<id> epic/<epic-id>`, a mid-ticket recycle resumes the existing
branch with all in-progress commits intact.

## Phase 3 -- Manage the validation loop

This is your main operating loop. You will receive messages from teammates
and route them appropriately.

### Wave tracking

Track two variables throughout the run:

- **`current_wave`** — set of ticket IDs currently in flight (dispatched but not yet closed)
- **`wave_number`** — starts at 1, increments at each wave boundary restart

Add a ticket to `current_wave` when dispatched. Remove it when closed and merged.
A wave is complete when `current_wave` is empty **and** all agents are idle (no
in-flight reviews or verifications pending). A ticket in a findings-rework loop is
not closed, so it holds the wave open.

When a wave completes, check for newly unblocked epic tickets. If any exist, trigger
a wave boundary restart before dispatching them (see "When the wave is complete" below).
If none remain and all child tickets are closed, proceed to Phase 4.

### Validation overview

Each ticket goes through this sequence. Any fix restarts from the top.

```
1. Implementer commits, signals "done"
2. Team lead routes to AC verifier
3. AC verifier: writes detailed results as note on ticket, sends PASS/FAIL to lead
   - FAIL -> lead points implementer at ticket for details -> back to 1
   - PASS -> continue to 4
4. Team lead routes to quality reviewer
5. Quality reviewer: creates tk tickets for findings, reports summary to lead
   - Critical/High findings exist -> lead forwards finding ticket IDs
     to implementer -> back to 1
   - Clean (or medium/low only) -> continue to 6
6. Team lead closes the implementation ticket, merges ticket branch into
   epic/<epic-id> integration branch, closes any critical/high quality
   finding tickets, dispatches next work
```

The detailed handling for each message type follows below.

### When an implementer says "done":

The implementer will send you a message with the ticket ID and branch name.

1. Send a message to the AC verifier via SendMessage:
   ```
   SendMessage({
     recipient: "ac-verifier",
     content: "Verify <ticket-id> on branch <branch-name>. Run
     `tk show <ticket-id>` for the acceptance criteria."
   })
   ```

2. Wait for the AC verifier's response.

### When the AC verifier returns PASS:

1. Send a message to the quality reviewer via SendMessage:
   ```
   SendMessage({
     recipient: "quality-reviewer",
     content: "Review <ticket-id> on branch <branch-name>. Changes
     have passed AC verification. Diff the ticket's own changes only
     (not prior wave changes already merged to the integration branch)
     with: git diff epic/<epic-id>...<branch-name>
     Parent epic for any finding tickets: <epic-id>"
   })
   ```

2. Wait for the quality reviewer's response.

### When the AC verifier returns FAIL:

1. Tell the implementer to check the ticket for details via SendMessage:
   ```
   SendMessage({
     recipient: "<implementer-name>",
     content: "AC verification failed for <ticket-id>. The verifier
     noted the specific failures on the ticket -- run
     `tk show <ticket-id>` for details. Address the issues, recommit,
     and let me know when ready."
   })
   ```

2. The implementer will fix and signal "done" again, restarting the cycle.

### When the quality reviewer returns CLEAN:

The ticket is fully validated. The quality reviewer may have created
medium/low finding tickets -- these are tracked but non-blocking.

1. Record a note on the implementation ticket:
   ```bash
   tk add-note <ticket-id> "Passed AC verification and quality review."
   ```

2. Close the implementation ticket:
   ```bash
   tk close <ticket-id>
   ```

3. Merge the ticket branch into the integration branch. Never `cd` to a
   different directory for merges — use checkout/merge/checkout in place,
   or `git -C` if merging in a separate worktree. The team lead's CWD must
   stay at `REPO_ROOT` so agents spawned later inherit the correct CWD:
   ```bash
   git checkout epic/<epic-id>
   git merge <branch-name> --no-ff -m "Merge <ticket-id>: <ticket title>"
   git checkout main
   ```
   If the merge produces conflicts, see the "Merge conflicts" edge case below.

4. If the quality reviewer created any medium/low finding tickets, note their
   IDs on the implementation ticket for reference but leave them open for
   future work:
   ```bash
   tk add-note <ticket-id> "Non-blocking quality findings: <finding-ticket-ids>"
   ```

5. Check if new tickets are unblocked:
   ```bash
   tk ready
   ```
   Filter to tickets under this epic. If new work is available, create a
   task and dispatch it:
   ```
   TaskCreate({
     subject: "Implement <ticket-id>: <ticket title>",
     description: "Run `tk show <ticket-id>` for full context..."
   })
   ```

6. Remove `<ticket-id>` from `current_wave`. Stand the implementer down — do not
   dispatch new work directly here, even if unblocked tickets exist. New work is
   dispatched only after the wave boundary restart:
   ```
   SendMessage({
     recipient: "<implementer-name>",
     content: "<ticket-id> closed and merged. Stand by — do not start new work."
   })
   ```
   If `current_wave` is now empty and all agents are idle, proceed to
   "When the wave is complete" below.

### When the quality reviewer returns FINDINGS with critical or high tickets:

The quality reviewer has already created tk tickets for each finding. You
receive the ticket IDs and their severities.

1. Forward the critical/high finding ticket IDs to the implementer:
   ```
   SendMessage({
     recipient: "<implementer-name>",
     content: "Quality review found issues that must be fixed before
     <ticket-id> can merge:

     Critical/High (must fix):
     - [<finding-id>] <title>
     - [<finding-id>] <title>

     Run `tk show <finding-id>` for details on each. Address these
     issues, recommit, and let me know when ready. This will go
     through the full validation cycle again (AC first, then quality)."
   })
   ```

2. The implementer will fix and signal "done" again, restarting the full cycle
   from AC verification.

3. When the implementation ticket eventually passes validation and closes,
   also close the critical/high finding tickets that were addressed:
   ```bash
   tk close <finding-id>
   tk add-note <finding-id> "Fixed in <ticket-id>"
   ```

### When the wave is complete

Triggered when `current_wave` is empty and all agents are idle (including reviewers
and verifiers — no pending verifications or reviews). Check for new work:

```bash
tk ready
# filter output to tickets belonging to this epic
```

**If no tickets remain unblocked and all child tickets are closed:** proceed to Phase 4.

**If new tickets are ready:** restart all agents before dispatching wave N+1.
Restarting clears accumulated context and eliminates compaction risk on long epics.
Worktrees persist — only agent contexts reset.

**1. Announce:**

```
Wave <N> complete — <M> tickets merged to epic/<epic-id>
Wave <N+1>: <K> new tickets unblocked — restarting agents for clean context
```

**2. Shutdown all agents.** Send shutdown to each; wait up to 30 seconds for
`SHUTDOWN_ACK <name>` from each. Proceed after timeout — agents should be idle.

```
SendMessage({ to: "implementer-1-<STAMP>", message: "type: shutdown_request" })
# ... all implementers
SendMessage({ to: "ac-verifier",           message: "type: shutdown_request" })
SendMessage({ to: "quality-reviewer",      message: "type: shutdown_request" })
```

**3. Compute next wave's implementer count:** `min(cap, len(new_tickets))`. Only
spawn as many implementers as needed for this wave — idle agents waste cost.

**4. Reset CWD and re-spawn all agents.** Before spawning, verify the team
lead is at `REPO_ROOT` — merge operations may have drifted the CWD:

```bash
cd <REPO_ROOT> && pwd
```

Implementers reuse their pre-created worktrees. Do NOT use `isolation: "worktree"`
on re-spawn — the worktrees already exist, and the isolation parameter creates a
new worktree via raw `git worktree add`, bypassing the `worktree-init` setup.

Write the full implementer prompt — do not abbreviate or reference Phase 1.5:

```
Agent({
  subagent_type: "implementer",
  team_name: "epic-<epic-id>",
  name: "implementer-<N>-<STAMP>",
  prompt: "You are an implementer on a team.

  WORKTREE: <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP>

  Before doing anything else, run this single Bash call to set your CWD
  and verify isolation:
  \`\`\`
  cd <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
  \`\`\`
  Report the pwd output and result to the team lead via SendMessage.

  All tool calls MUST target your worktree, not the main repo:
  - Bash: your CWD is already set — just run commands directly
  - Read/Edit: absolute paths starting with <REPO_ROOT>/.worktrees/implementer-<N>-<STAMP>/
  - Glob/Grep: pass path=<REPO_ROOT>/.worktrees/implementer-<N>-<STAMP>
  Never reference <REPO_ROOT> without the .worktrees/implementer-<N>-<STAMP> suffix.

  Git: your CWD is already the worktree — always use plain \`git\` with no -C flag.
  Never use \`git -C <path>\` in implementer code; that is reserved for the team lead
  when it operates outside its own working directory.

  Then wait for the team lead to assign you a ticket via SendMessage. Do NOT
  claim tickets from the task list — the team lead routes all work.

  For each ticket assignment:
  1. Check out the ticket branch — resume if it exists, otherwise branch fresh
     from the latest integration state:
     \`git checkout ticket/<ticket-id> 2>/dev/null || git checkout -b ticket/<ticket-id> epic/<epic-id>\`
     The first form preserves in-progress work if you were recycled mid-ticket;
     the second creates a fresh branch off the latest integration state for new work.
  2. Run \`tk show <ticket-id>\` for full context
  3. Send STATUS to team lead: 'STATUS <name>: read <ticket-id>, starting implementation'
  4. Implement the fix
  5. Send STATUS to team lead: 'STATUS <name>: implementation done on <ticket-id>, running tests'
  6. Run tests from your worktree
  7. Commit to ticket/<ticket-id>
  8. Message the team lead: DONE <ticket-id> ticket/<ticket-id>

  Then wait for your next assignment. When you receive a message containing
  'type: shutdown_request', reply with SHUTDOWN_ACK <name> then stop."
})
# ... repeat for needed implementer count
Agent({ subagent_type: "ac-verifier",      team_name: "epic-<epic-id>", name: "ac-verifier",
        prompt: "<same as Phase 1.5>" })
Agent({ subagent_type: "quality-reviewer", team_name: "epic-<epic-id>", name: "quality-reviewer",
        prompt: "<same as Phase 1.5>" })

**5. Wait for `WORKTREE OK`** from all re-spawned implementers. Each must
report the `pwd` output showing their worktree path. Apply the same abort
logic as Phase 2 — if any report `WARNING` or a wrong path, stop.

**6. Dispatch wave N+1 tickets** to implementers via SendMessage (same format as
Phase 1.5). Add all dispatched ticket IDs to `current_wave`. Increment `wave_number`.

**Known limitation:** agent restarts clear context between waves but do not protect
against compaction during a single long-running ticket. If a ticket is complex
enough to trigger compaction mid-implementation, consider splitting it.

## Phase 4 -- Epic completion

When all child tickets of the epic are closed:

1. Report to the user with actionable next steps:
   ```
   Epic <epic-id> complete. All N tickets implemented and validated.

   Summary:
     [<id>] <title> -- closed, merged to epic/<epic-id>
     [<id>] <title> -- closed, merged to epic/<epic-id>
     ...

   All ticket branches have been merged to the integration branch:
     epic/<epic-id>

   Next steps:
     1. Run deep review:
        /multi-review git diff main epic/<epic-id> --
     2. Address any critical/high findings from the deep review
     3. Merge to main:
        git checkout main && git merge epic/<epic-id> --no-ff
   ```

2. If there are non-blocking quality finding tickets still open, list them:
   ```
   Non-blocking findings left open (medium/low, tracked as tk tickets):
     <finding-ticket-ids>
   ```

3. Shut down all teammates by sending shutdown requests:
   ```
   SendMessage({ to: "implementer-1-<STAMP>", message: "type: shutdown_request" })
   # ... all implementers
   SendMessage({ to: "ac-verifier",           message: "type: shutdown_request" })
   SendMessage({ to: "quality-reviewer",      message: "type: shutdown_request" })
   ```

4. Wait briefly for teammates to acknowledge, then clean up worktrees
   and the team:
   ```bash
   # Clean up implementer worktrees (adjust count to match)
   for N in 1 2 3; do
     git worktree remove .worktrees/implementer-$N-<STAMP> --force 2>/dev/null || true
   done
   ```
   ```
   TeamDelete()
   ```

## Edge Cases

**All implementers are busy and new tickets unblock.** Note the newly available
tickets. When an implementer finishes their current ticket, dispatch the new
work to them. Don't spawn additional implementers mid-run unless the user
requests it.

**Implementer fails AC verification more than 3 times on the same ticket.**
This suggests the ticket's AC may be ambiguous or the implementer is stuck.
Escalate to the user:

> <ticket-id> has failed AC verification 3 times. The implementer may be
> stuck or the acceptance criteria may need clarification. Want to:
> 1. Review the AC and provide guidance
> 2. Reassign to a different implementer (fresh context)
> 3. Skip this ticket for now

**Merge conflicts when merging to integration branch.** If merging a completed
ticket branch into `epic/<epic-id>` produces conflicts, route them back to the
implementer:

```
SendMessage({
  recipient: "<implementer-name>",
  content: "Merge conflict when integrating <ticket-id> into
  epic/<epic-id>. Check out epic/<epic-id>, merge your branch, resolve
  the conflicts, commit, and let me know when done. This will go
  through the full validation cycle again."
})
```

After conflict resolution, re-run the full validation cycle since the
resolved code may differ from what was originally validated.

**No ready tickets at startup.** All tickets are either blocked, in-progress,
or closed. Tell the user:

> No unblocked tickets found for epic <epic-id>. Check `tk blocked` to see
> what's holding things up.

**User wants to stop mid-epic.** Send shutdown_request to all teammates via
SendMessage, wait for acknowledgments, then call TeamDelete. In-progress
tickets remain marked as in-progress in tk. The user can resume later by
running /run-epic again (in-progress tickets will show as claimable).