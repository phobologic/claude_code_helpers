---
name: run-epic
description: >
  Execute a tk epic using an agent team. Creates implementer, AC verifier, and
  quality reviewer teammates, dispatches unblocked tickets for parallel
  implementation, and manages the validation loop. Use when the user says
  "run epic", "execute epic", "start working on the epic", or similar.
argument-hint: "<epic-id>"
model: sonnet
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

### Findings parent epic

Establish a `FINDINGS_PARENT` epic ID that every out-of-scope finding ticket
(created by the quality reviewer or by the team lead from an OUT_OF_SCOPE
pushback) will be parented to. Without this, findings get created as orphans
and have to be re-parented by hand after the run.

Findings belong one level *above* the epic being run so they're visible
alongside the epic itself in `tk epic-status`:

- Read the epic you're executing with `tk show <epic-id>` and inspect its
  `.parent` field.
- **If the epic has a parent:** `FINDINGS_PARENT = <epic's parent>`. Findings
  roll up under the same grandparent the phase epic belongs to.
- **If the epic is top-level (no parent):** `FINDINGS_PARENT = <epic-id>`
  itself. Findings become siblings of the epic's implementation tickets.
  This keeps everything under one rollup rather than creating orphans or
  a synthetic sibling epic.

Record `FINDINGS_PARENT` — you'll pass it to every quality reviewer routing
message so finding tickets land under it automatically.

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
git show-ref --verify --quiet refs/heads/epic/<epic-id> && git checkout epic/<epic-id> || git checkout -b epic/<epic-id> main
git checkout main  # return to main, implementers branch from here
```

Record `REPO_ROOT` and `STAMP` — you'll use them in worktree paths for implementer prompts.

**Pre-flight the main repo state.** A dirty working tree or a leftover stash
can corrupt later wave merges (see "Dirty working tree guard" in Edge Cases
for the incident this guards against). Abort startup if either condition
holds, and tell the user what to fix:

```bash
git -C $REPO_ROOT status --porcelain   # must be empty
git -C $REPO_ROOT stash list            # must be empty
```

If either command produces output, stop and report to the user — do not
auto-clean. A stash may contain the user's in-progress work.

### Step 1.2: Pre-create worktrees for all sandboxed agents

Every agent that has `Bash` access runs in its own worktree — implementers
**and** the ac-verifier and quality-reviewer. Sharing the main repo's working
tree between agents caused a past corruption incident: an agent ran
`git stash && git checkout <branch> && ...; git stash pop` in the main repo,
silently popped an unrelated stale stash, and wedged `pbp/app.py` with
conflict markers mid-run. Isolation is the fix.

Do not rely on the `isolation: "worktree"` parameter — that hook only fires
reliably in the main session, not from sub-agent contexts.

Use `worktree-init` (not raw `git worktree add`) — it applies `.worktreelinks`
and `.worktreeinclude` setup so shared state (e.g. `.tickets/`) is available
in each worktree.

```bash
# Create one worktree per implementer (min(3-4, ready_ticket_count))
worktree-init implementer-1-$STAMP $REPO_ROOT
worktree-init implementer-2-$STAMP $REPO_ROOT
# ... repeat for each implementer

# Create worktrees for the verifier and reviewer as well
worktree-init ac-verifier-$STAMP $REPO_ROOT
worktree-init quality-reviewer-$STAMP $REPO_ROOT
```

Verify each was created: `ls .worktrees/` should show all worktree dirs.

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
     `git show-ref --verify --quiet refs/heads/ticket/<ticket-id> && git checkout ticket/<ticket-id> || git checkout -b ticket/<ticket-id> epic/<epic-id>`
     The first form preserves in-progress work if you were recycled mid-ticket;
     the second creates a fresh branch off the latest integration state for new work.
  2. Run `tk show <ticket-id>` for full context
  3. Send STATUS to team lead: 'STATUS <name>: read <ticket-id>, starting implementation'
  4. Implement the fix
  5. Send STATUS to team lead: 'STATUS <name>: implementation done on <ticket-id>, running tests'
  6. Run tests from your worktree
  7. Commit to ticket/<ticket-id>
  8. Message the team lead: DONE <ticket-id> ticket/<ticket-id>

  Then wait for your next assignment. When you receive a message with
  `type: \"shutdown_request\"`, send back via SendMessage:
  \`\`\`
  { to: \"team-lead\", message: { type: \"shutdown_response\", request_id: <echo from request>, approve: true } }
  \`\`\`
  The runtime terminates your process automatically once that response is sent.",
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
  prompt: "You are the AC verifier on a team.

  WORKTREE: <REPO_ROOT>/.worktrees/ac-verifier-<STAMP>

  Before doing anything else, run this single Bash call to set your CWD
  and verify isolation:
  ```
  cd <REPO_ROOT>/.worktrees/ac-verifier-<STAMP> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
  ```
  Report the result to the team lead via SendMessage.

  All Bash/Read/Edit/Glob/Grep calls MUST target your worktree. Never
  reference <REPO_ROOT> without the .worktrees/ac-verifier-<STAMP> suffix.
  Git: your CWD is already the worktree — use plain `git` with no -C flag.

  HARD RULES — the team lead relies on these for wave-merge safety:
  - NEVER run `git stash`, `git stash pop`, `git stash apply`, or
    `git checkout -m` anywhere. If you need to run code against a branch,
    `git checkout` that branch inside your own worktree — never in the main
    repo.
  - NEVER cd or -C into <REPO_ROOT> or any other worktree.
  - Prefer `git diff`, `git show`, `git cat-file` over checking branches out
    at all. Only check out a branch when you genuinely need to execute code.

  Wait for the team lead to send you tickets to verify. Do not claim tasks
  from the task list. When you receive a message with `type: \"shutdown_request\"`,
  send back via SendMessage:
  \`\`\`
  { to: \"team-lead\", message: { type: \"shutdown_response\", request_id: <echo from request>, approve: true } }
  \`\`\`
  The runtime terminates your process automatically once that response is sent.",
  subagent_type: "ac-verifier",
  team_name: "epic-<epic-id>",
  name: "ac-verifier"
})
```

**Quality reviewer:**

```
Agent({
  prompt: "You are the quality reviewer on a team.

  WORKTREE: <REPO_ROOT>/.worktrees/quality-reviewer-<STAMP>

  Before doing anything else, run this single Bash call to set your CWD
  and verify isolation:
  ```
  cd <REPO_ROOT>/.worktrees/quality-reviewer-<STAMP> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
  ```
  Report the result to the team lead via SendMessage.

  All Bash/Read/Edit/Glob/Grep calls MUST target your worktree. Never
  reference <REPO_ROOT> without the .worktrees/quality-reviewer-<STAMP>
  suffix. Git: your CWD is already the worktree — use plain `git` with no
  -C flag.

  HARD RULES — the team lead relies on these for wave-merge safety:
  - NEVER run `git stash`, `git stash pop`, `git stash apply`, or
    `git checkout -m` anywhere. If you need to run code against a branch,
    `git checkout` that branch inside your own worktree — never in the main
    repo.
  - NEVER cd or -C into <REPO_ROOT> or any other worktree.
  - Prefer `git diff`, `git show`, `git cat-file` over checking branches out
    at all.

  Wait for the team lead to send you tickets to review. Do not claim tasks
  from the task list.

  For each ticket routed:
  1. Read `tk show <ticket-id>` to understand what was being fixed
  2. Read the diff on the branch provided
  3. Triage findings per your agent instructions:
     - Inline-fixable (Critical/High/Medium scoped to files the ticket touched)
       → list inline in the REWORK verdict; do NOT create tickets for these
     - Out-of-scope findings and all Lows → create tk tickets with the
       parent epic ID the team lead provides
  4. Return one of three verdicts to the team lead:
     - CLEAN — no blocking issues (Lows may still have been ticketed)
     - REWORK — numbered inline list of findings for same-run rework
     - FINDINGS — all blockers were out-of-scope; list the ticketed IDs

  When you receive a message with `type: \"shutdown_request\"`, send back via SendMessage:
  \`\`\`
  { to: \"team-lead\", message: { type: \"shutdown_response\", request_id: <echo from request>, approve: true } }
  \`\`\`
  The runtime terminates your process automatically once that response is sent.",
  subagent_type: "quality-reviewer",
  team_name: "epic-<epic-id>",
  name: "quality-reviewer"
})
```

## Phase 2 -- Verify worktree isolation

After spawning all agents, wait for `WORKTREE OK` from **every sandboxed
teammate** — implementers, ac-verifier, and quality-reviewer. Each will report
back `WORKTREE OK` or `WARNING: not in worktree`.

- If **all report `WORKTREE OK`**: proceed to Phase 3.
- If **any report `WARNING`** (or a wrong path): stop immediately and tell the user:
  > Worktree isolation failed — one or more agents are running in the main repo.
  > This will cause main-repo corruption. Aborting.
  Then shut down all teammates and call `TeamDelete()`.

If any teammate failed to spawn entirely, retry the Agent call. If repeated
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

Long-running tickets — especially those that go through several findings or
AC-fail rework cycles — can push an implementer toward context compaction
across tickets. Recycle each implementer once the ticket they just completed
reaches CLOSED (merged) or BLOCKED, before they pick up a new ticket.
Mid-ticket rework keeps the same implementer (preserving in-flight context).

**Trigger.** Once a ticket reaches CLOSED or BLOCKED, recycle the implementer
that owned it before assigning the next ticket to that slot.

**Recycle procedure (per implementer — clean teardown and rebuild):**

1. Send shutdown to that one implementer:
   ```
   SendMessage({ to: "<name>", message: "type: shutdown_request" })
   ```
2. Wait up to 30 seconds for a `shutdown_response` from `<name>` (the runtime
   terminates the process when that response arrives). The implementer is idle
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
6. Update the dashboard with event header `recycled <name>`.
7. Now dispatch the next work message to the fresh implementer.

The other implementers, the integration branch, the AC verifier, the
quality reviewer, and any in-flight reviews are untouched — this is a
strictly per-implementer operation. Because the implementer prompt's first
step is `git show-ref --verify --quiet refs/heads/ticket/<id> && git checkout ticket/<id> || git checkout -b ticket/<id> epic/<epic-id>`, a mid-ticket recycle resumes the existing
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

Track per ticket two counters that you maintain across rework loops:
- `rework_count[ticket-id]` — REWORK verdicts seen so far (resets on user
  guidance, used by the 3-strike escalation below)
- `total_qr_rounds[ticket-id]` — every QR review (CLEAN/REWORK/FINDINGS)
  observed for this ticket. NEVER reset — drives the round number sent to
  the QR and the hard 5-round cap.

1. Send a message to the quality reviewer via SendMessage. Include the round
   number so the reviewer can apply round-aware scope rules and read prior
   round notes:
   ```
   SendMessage({
     recipient: "quality-reviewer",
     content: "Review <ticket-id> on branch <branch-name> (round <total_qr_rounds[ticket-id] + 1>).
     Changes have passed AC verification. Diff the ticket's own changes only
     (not prior wave changes already merged to the integration branch)
     with: git diff epic/<epic-id>...<branch-name>

     Findings parent: <FINDINGS_PARENT>. Any ticket you create (out-of-scope
     findings and Lows) must be created with `--parent <FINDINGS_PARENT>`
     so findings roll up under the right epic.

     Run `tk show <ticket-id>` first and read prior-round notes — earlier QR
     verdicts, OOS tickets already filed, and implementer rework summaries.
     Do not re-pull concerns previous rounds ticketed as out-of-scope. On
     round ≥ 2, only flag findings that trace to a regression introduced by
     the most recent implementer change or a critical bug prior fixes could
     not address."
   })
   ```

2. Wait for the quality reviewer's response. The reviewer returns one of
   three verdicts: `CLEAN`, `REWORK`, or `FINDINGS`. Route based on which
   keyword appears in the first line.

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
   stay at `REPO_ROOT` so agents spawned later inherit the correct CWD.

   **Pre-flight the main repo before every merge.** Abort the chain if the
   working tree is dirty — that means something corrupted it since the last
   wave and merging on top will either fail with `needs merge` or silently
   carry the corruption forward. See "Dirty working tree guard" in Edge Cases.
   ```bash
   if [ -n "$(git -C $REPO_ROOT status --porcelain)" ]; then
     echo "ABORT: main repo working tree is dirty before merge"
     git -C $REPO_ROOT status
     # stop and escalate to the user — do not proceed
   fi
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

### When the quality reviewer returns REWORK:

The reviewer has found inline-fixable issues (Critical, High, or Medium)
scoped to files the ticket already touched. No tickets have been created --
the findings are listed inline in the verdict message. Forward them verbatim
to the implementer with the OUT_OF_SCOPE escape hatch:

1. Forward the inline findings:
   ```
   SendMessage({
     recipient: "<implementer-name>",
     content: "Quality review returned REWORK for <ticket-id>. Fix these in
     your branch and signal DONE again:

     <paste the numbered finding list from the reviewer's REWORK message verbatim>

     If you believe any individual finding is genuinely out of scope (would
     require touching files the ticket never named), SendMessage me back with
     one line per such finding:
       OUT_OF_SCOPE <n>: <one-sentence reason>
     and I will convert those to new tickets instead of blocking the merge.
     Fix every finding you do not push back on before signaling DONE."
   })
   ```

2. When the implementer replies:
   - For each `OUT_OF_SCOPE <n>: <reason>` line, create a new tk ticket using
     the same format the quality-reviewer would have (title from the finding,
     `-p` by the finding's priority word, body with file/line/description), and parent it to
     `FINDINGS_PARENT`: `tk create ... --parent <FINDINGS_PARENT>`. Note these
     tickets on the implementation ticket and remove them from the blocking set.
   - When the implementer signals DONE again, restart the full validation
     cycle from AC verification.

3. Increment both `rework_count[ticket-id]` and `total_qr_rounds[ticket-id]`
   on every REWORK verdict (also increment `total_qr_rounds` on CLEAN and
   FINDINGS for accurate round numbering). After 3 REWORK verdicts (the
   `rework_count` 3-strike), escalate per "Ticket stuck in rework loop" in
   Edge Cases. Independently, if `total_qr_rounds[ticket-id] >= 5`, escalate
   with the drift framing — see "QR drift cap" in Edge Cases. The
   total-rounds cap is durable: do NOT reset it on user guidance.

### When the quality reviewer returns FINDINGS:

This is the narrow case where every blocking finding was genuinely out of
scope and has already been ticketed by the reviewer. It does NOT block merge.

1. Note the finding ticket IDs on the implementation ticket:
   ```bash
   tk add-note <ticket-id> "Quality review: out-of-scope findings ticketed: \
   <finding-ids>"
   ```
2. Proceed to merge exactly as for CLEAN (see above).

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
a `shutdown_response` from each (the runtime terminates each process when its
response arrives). Proceed after timeout — agents should be idle.

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
     \`git show-ref --verify --quiet refs/heads/ticket/<ticket-id> && git checkout ticket/<ticket-id> || git checkout -b ticket/<ticket-id> epic/<epic-id>\`
     The first form preserves in-progress work if you were recycled mid-ticket;
     the second creates a fresh branch off the latest integration state for new work.
  2. Run \`tk show <ticket-id>\` for full context
  3. Send STATUS to team lead: 'STATUS <name>: read <ticket-id>, starting implementation'
  4. Implement the fix
  5. Send STATUS to team lead: 'STATUS <name>: implementation done on <ticket-id>, running tests'
  6. Run tests from your worktree
  7. Commit to ticket/<ticket-id>
  8. Message the team lead: DONE <ticket-id> ticket/<ticket-id>

  Then wait for your next assignment. When you receive a message with
  `type: \"shutdown_request\"`, send back via SendMessage:
  \`\`\`
  { to: \"team-lead\", message: { type: \"shutdown_response\", request_id: <echo from request>, approve: true } }
  \`\`\`
  The runtime terminates your process automatically once that response is sent."
})
# ... repeat for needed implementer count
Agent({ subagent_type: "ac-verifier",      team_name: "epic-<epic-id>", name: "ac-verifier",
        prompt: "<same as Phase 1.5 — full worktree cd + HARD RULES block>" })
Agent({ subagent_type: "quality-reviewer", team_name: "epic-<epic-id>", name: "quality-reviewer",
        prompt: "<same as Phase 1.5 — full worktree cd + HARD RULES block>" })

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
     3. Review produced findings:
        tk triage --epic <FINDINGS_PARENT> --sort priority,confidence
     4. Merge to main:
        git checkout main && git merge epic/<epic-id> --no-ff
   ```

   Findings carry a priority (Critical/High/Medium/Low → `-p 0..3`) and an
   epistemic confidence score (0–100) — see the reviewer agents for the rubric.
   `tk triage --sort priority,confidence` walks them highest-priority-first,
   then highest-confidence within each priority band.

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
   # Clean up verifier and reviewer worktrees
   git worktree remove .worktrees/ac-verifier-<STAMP>      --force 2>/dev/null || true
   git worktree remove .worktrees/quality-reviewer-<STAMP> --force 2>/dev/null || true
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

**QR drift cap (`total_qr_rounds[ticket-id] >= 5`).** Independent of the
3-strike `rework_count` escalation. When the total cap is hit, escalate with
drift framing:

> `<ticket-id>` has been through quality review 5 times. This is past the
> hard cap. Possible causes:
> 1. **Reviewer drift** — successive reviewers moved the goalposts.
>    Recommended action: merge the current branch and let me file remaining
>    concerns as new tickets.
> 2. **Implementer can't address findings** — fixes regress or miss the
>    point. Recommended action: reassign with explicit guidance.
> 3. **Mark BLOCKED** and continue with other tickets.

Run `tk show <ticket-id>` (or read the QR round notes) before deciding.
Option 1 routes the ticket directly to MERGING (skip remaining QR loops);
options 2 and 3 follow the standard handlers. Do NOT reset
`total_qr_rounds[ticket-id]` on user guidance — the cap is durable across
all rework loops for this ticket.

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

**Dirty working tree guard.** The main repo's working tree must stay clean
for the entire run. If the pre-merge check (`git status --porcelain` in
Phase 3) returns any output, something corrupted it since the last wave —
almost always a sandboxed agent that ran `git checkout` or `git stash` in
the main repo instead of its own worktree. Do not try to auto-recover. Stop
the run, report to the user with the offending status output, and let the
user triage. Incident that motivated this guard: an ac-verifier ran
`git stash && git checkout <branch> && ... ; git checkout - ; git stash pop`
in the main repo, the initial `stash` was a no-op on a clean tree, and the
final `pop` silently applied an 8-day-old stale stash, wedging `pbp/app.py`
with `<<<<<<< Updated upstream` markers mid-run. The Phase 1.1 stash-list
guard and per-agent worktrees prevent it at the source; this guard catches
any new variant of the same bug.

**User wants to stop mid-epic.** Send shutdown_request to all teammates via
SendMessage, wait for acknowledgments, then call TeamDelete. In-progress
tickets remain marked as in-progress in tk. The user can resume later by
running /run-epic again (in-progress tickets will show as claimable).