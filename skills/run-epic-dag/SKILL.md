---
name: run-epic-dag
description: >
  Execute a tk epic using a DAG-driven agent team with continuous dispatching.
  Spawns a fixed pool of 4 implementers, 2 quality reviewers, and 1 AC verifier
  at startup; dispatches tickets as they unblock without wave boundaries. Use when
  the user says "run epic dag", "execute epic with dag", or similar.
argument-hint: "<epic-id>"
---

# Run Epic DAG

You are the team lead for a DAG-driven epic execution. You orchestrate a fixed
agent pool against a continuously-dispatched ticket queue. You never implement,
never review, never make judgment calls about code. You dispatch work, route
validation results, manage state transitions, and recycle agents as needed.

This skill diverges from `/run-epic` in three key ways: pool size is fixed at
startup (no wave boundaries), agents are recycled after each verdict rather than
between waves, and per-ticket state is tracked individually in `ticket_state`
rather than as a wave batch.

---

## Phase 0 — Parse arguments and load epic

If `$ARGUMENTS` is empty, ask the user for an epic ID.

Load the epic and its children:

```bash
tk show <epic-id>
tk query '.parent == "<epic-id>"'
```

Verify this is actually an epic (type == "epic"). If not, tell the user and stop.

Check for child tickets. If there are none, tell the user the epic has no
tickets and stop.

If `tk ready` returns no tickets for this epic, report:

> No unblocked tickets found for epic `<epic-id>`. Check `tk blocked` to see
> what is holding things up. The run cannot proceed until at least one ticket
> is unblocked.

Stop — do not create the team.

Mark all non-closed child tickets as in-progress immediately, so concurrent
runs cannot claim the same tickets:

```bash
tk start <ticket-id>
# repeat for each non-closed child ticket
```

### Findings parent

Establish a `FINDINGS_PARENT` epic ID for out-of-scope finding tickets:

- Read the epic's `.parent` field with `tk show <epic-id>`.
- **If the epic has a parent:** `FINDINGS_PARENT = <epic's parent>`.
- **If the epic is top-level:** `FINDINGS_PARENT = <epic-id>` itself.

Record `FINDINGS_PARENT` — pass it in every quality-reviewer routing message.

### In-memory state

Initialize the following structures before creating the team:

```
ticket_state: Map<ticket_id, TicketState>
  # state: DISPATCHED | IMPL_DONE | VERIFYING | REWORK | MERGING | MERGED | CLOSED | BLOCKED
  # verification_phase: "ac" | "quality" | null

agent_pool: Map<slot_name, AgentSlot>
  # slot_name: "dag-impl-1" .. "dag-impl-4"
  # assignee: ticket_id | null
  # assignments_since_spawn: int
  # worktree: "<REPO_ROOT>/.worktrees/epic-dag-<stamp>-impl-<N>"

ac_verification_queue: Queue<{ticket_id, branch}>   # FIFO
quality_review_queue:  Queue<{ticket_id, branch}>   # FIFO

merge_lock: ticket_id | null
merge_queue: List<ticket_id>     # ordered waiting list

findings_parent: ticket_id = FINDINGS_PARENT

ac_fail_count: Map<ticket_id, int>     # reset to 0 on each fresh dispatch
rework_count:  Map<ticket_id, int>     # reset to 0 on each fresh dispatch

RECYCLE_CAP = 3
```

### Startup summary

Present a summary to the user:

```
Epic: <title>
Tickets: N total, M ready (unblocked), K in-progress, J closed

Ready tickets:
  [<id>] <title>
  ...

Blocked tickets:
  [<id>] <title> (blocked by: <dep-ids>)
  ...

Pool: 4 implementers · 2 quality reviewers · 1 AC verifier
```

Then confirm via `AskUserQuestion`:

```
AskUserQuestion({
  questions: [{
    question: "Proceed with DAG execution for this epic?",
    header: "Run epic (DAG)",
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

Wait for the user's answer before creating the team.

---

## Phase 1 — Create the agent team

### Step 1.1: Create integration branch and capture repo root

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
REPO_ROOT=$(pwd)
git show-ref --verify --quiet refs/heads/epic/<epic-id> && git checkout epic/<epic-id> || git checkout -b epic/<epic-id> main
git checkout main
```

The `$STAMP` is used only to namespace worktree directory paths so that two
concurrent `/run-epic-dag` invocations on the same repo (e.g. different epics)
never share filesystem state. Agent slot names (`dag-impl-1` etc.) stay short
because they are scoped by `team_name`.

Pre-flight the main repo state before proceeding:

```bash
git -C $REPO_ROOT status --porcelain   # must be empty
git -C $REPO_ROOT stash list            # must be empty
```

If either produces output, stop and report to the user — do not auto-clean.

### Step 1.2: Pre-create worktrees for all agents

Worktree directory names are **stamp-scoped** (using the `$STAMP` from
Phase 1.1) so concurrent `/run-epic-dag` invocations in the same repo never
share worktrees. Within a single run, implementer slots stably map to the
same worktree across recycle cycles.

```bash
# 4 implementer worktrees
worktree-init epic-dag-$STAMP-impl-1 $REPO_ROOT
worktree-init epic-dag-$STAMP-impl-2 $REPO_ROOT
worktree-init epic-dag-$STAMP-impl-3 $REPO_ROOT
worktree-init epic-dag-$STAMP-impl-4 $REPO_ROOT

# 1 AC verifier worktree
worktree-init epic-dag-$STAMP-ac-verifier $REPO_ROOT

# 2 quality reviewer worktrees
worktree-init epic-dag-$STAMP-qr-1 $REPO_ROOT
worktree-init epic-dag-$STAMP-qr-2 $REPO_ROOT
```

Verify all were created: `ls .worktrees/` must show all 7 `epic-dag-$STAMP-*`
directories.

Register worktree paths in `agent_pool`:

```
agent_pool["dag-impl-1"].worktree = "$REPO_ROOT/.worktrees/epic-dag-$STAMP-impl-1"
agent_pool["dag-impl-2"].worktree = "$REPO_ROOT/.worktrees/epic-dag-$STAMP-impl-2"
agent_pool["dag-impl-3"].worktree = "$REPO_ROOT/.worktrees/epic-dag-$STAMP-impl-3"
agent_pool["dag-impl-4"].worktree = "$REPO_ROOT/.worktrees/epic-dag-$STAMP-impl-4"
```

### Step 1.3: Create the team

```
TeamCreate({
  team_name: "epic-dag-<epic-id>",
  description: "DAG-driven team executing epic <epic-id>: <epic title>"
})
```

### Step 1.4: Create initial tasks

Create a task for each ready ticket (up to 4):

```
TaskCreate({
  subject: "Implement <ticket-id>: <ticket title>",
  description: "Run `tk show <ticket-id>` for full context including
  description and acceptance criteria. Implement, write tests, ensure
  tests pass, commit, then message the team lead when done."
})
```

### Step 1.5: Spawn teammates

Spawn all agents using the `Agent` tool with `team_name: "epic-dag-<epic-id>"`.
All 4 implementers, both quality reviewers, and the AC verifier are spawned at
startup regardless of the number of ready tickets — excess implementers will be
idle until work arrives.

**Implementers** (spawn all 4 unconditionally):

For each slot N in 1..4:

```
Agent({
  subagent_type: "implementer",
  team_name: "epic-dag-<epic-id>",
  name: "dag-impl-<N>",
  prompt: "You are an implementer on a team.

WORKTREE: <REPO_ROOT>/.worktrees/epic-dag-<stamp>-impl-<N>

Before doing anything else, run this single Bash call to set your CWD
and verify isolation:
\`\`\`
cd <REPO_ROOT>/.worktrees/epic-dag-<stamp>-impl-<N> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
\`\`\`
Report the pwd output and result to the team lead via SendMessage.

All tool calls MUST target your worktree, not the main repo:
- Bash: your CWD is already set — just run commands directly
- Read/Edit: absolute paths starting with <REPO_ROOT>/.worktrees/epic-dag-<stamp>-impl-<N>/
- Glob/Grep: pass path=<REPO_ROOT>/.worktrees/epic-dag-<stamp>-impl-<N>
Never reference <REPO_ROOT> without the .worktrees/epic-dag-<stamp>-impl-<N> suffix.

Git: your CWD is already the worktree — always use plain \`git\` with no -C flag.
Never use \`git -C <path>\` in implementer code; that is reserved for the team lead.

Then wait for the team lead to assign you a ticket via SendMessage. Do NOT
claim tickets from the task list — the team lead routes all work.

For each ticket assignment:
1. Check out the ticket branch — resume if it exists, otherwise branch fresh
   from the latest integration state:
   \`git show-ref --verify --quiet refs/heads/ticket/<ticket-id> && git checkout ticket/<ticket-id> || git checkout -b ticket/<ticket-id> epic/<epic-id>\`
2. Run \`tk show <ticket-id>\` for full context
3. Send STATUS to team lead: 'STATUS dag-impl-<N>: read <ticket-id>, starting implementation'
4. Implement the fix
5. Send STATUS to team lead: 'STATUS dag-impl-<N>: implementation done on <ticket-id>, running tests'
6. Run tests from your worktree
7. Commit to ticket/<ticket-id>
8. Message the team lead: DONE <ticket-id> ticket/<ticket-id>

Then wait for your next assignment. When you receive a message containing
'type: shutdown_request', reply with SHUTDOWN_ACK dag-impl-<N> then stop."
})
```

**AC verifier** (1 instance):

```
Agent({
  subagent_type: "ac-verifier",
  team_name: "epic-dag-<epic-id>",
  name: "dag-ac-verifier",
  prompt: "You are the AC verifier on a team.

WORKTREE: <REPO_ROOT>/.worktrees/epic-dag-<stamp>-ac-verifier

Before doing anything else, run this single Bash call to set your CWD
and verify isolation:
\`\`\`
cd <REPO_ROOT>/.worktrees/epic-dag-<stamp>-ac-verifier && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
\`\`\`
Report the result to the team lead via SendMessage.

All Bash/Read/Edit/Glob/Grep calls MUST target your worktree. Never
reference <REPO_ROOT> without the .worktrees/epic-dag-<stamp>-ac-verifier suffix.
Git: your CWD is already the worktree — use plain \`git\` with no -C flag.

Wait for the team lead to send you a ticket to verify. Do not claim tasks
from the task list. After you return your verdict (PASS or FAIL), you will
be recycled — wait for the shutdown_request and reply with SHUTDOWN_ACK
dag-ac-verifier then stop."
})
```

**Quality reviewers** (2 instances):

For each slot K in 1..2:

```
Agent({
  subagent_type: "quality-reviewer",
  team_name: "epic-dag-<epic-id>",
  name: "dag-qr-<K>",
  prompt: "You are a quality reviewer on a team.

WORKTREE: <REPO_ROOT>/.worktrees/epic-dag-<stamp>-qr-<K>

Before doing anything else, run this single Bash call to set your CWD
and verify isolation:
\`\`\`
cd <REPO_ROOT>/.worktrees/epic-dag-<stamp>-qr-<K> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
\`\`\`
Report the result to the team lead via SendMessage.

All Bash/Read/Edit/Glob/Grep calls MUST target your worktree. Never
reference <REPO_ROOT> without the .worktrees/epic-dag-<stamp>-qr-<K> suffix.
Git: your CWD is already the worktree — use plain \`git\` with no -C flag.

Wait for the team lead to send you a ticket to review. Do not claim tasks
from the task list. After you return your verdict (CLEAN, REWORK, or
FINDINGS), you will be recycled — wait for the shutdown_request and reply
with SHUTDOWN_ACK dag-qr-<K> then stop."
})
```

---

## Phase 2 — Verify worktree isolation

After spawning all 7 agents, wait for `WORKTREE OK` from every teammate.
Each will report their `pwd` output and either `WORKTREE OK` or `WARNING:
not in worktree`.

- **All report `WORKTREE OK`**: proceed to Phase 3.
- **Any report `WARNING` or wrong path**: stop immediately:
  > Worktree isolation failed — one or more agents are running in the main
  > repo. Aborting to prevent main-repo corruption.
  Broadcast shutdown to all teammates and call `TeamDelete()`.

### Initial dispatch

Once isolation is confirmed, dispatch ready tickets (up to 4) to idle
implementer slots:

```
SendMessage({
  to: "dag-impl-<N>",
  message: "Ticket <ticket-id>: <ticket-title>

Implement this ticket. Branch:
  git show-ref --verify --quiet refs/heads/ticket/<ticket-id> && git checkout ticket/<ticket-id> || git checkout -b ticket/<ticket-id> epic/<epic-id>

Run \`tk show <ticket-id>\` for full context. Signal DONE when committed."
})
```

Set `agent_pool["dag-impl-<N>"].assignee = <ticket-id>`,
`assignments_since_spawn += 1`, and `ticket_state[<ticket-id>].state = DISPATCHED`.

If fewer than 4 ready tickets exist, the remaining implementer slots stay idle
(assignee = null). They will receive work as tickets unblock during the run.
Mid-run pool expansion (spawning additional implementers) is not supported.

---

## Phase 3 — Event loop

Process incoming messages from all agents and drive ticket state transitions.
The loop continues until every child ticket of the epic reaches CLOSED or BLOCKED.

### Message routing

Inspect the **first word** of every incoming message and route to the handler
below. On every message arrival: record the current clock time as "Last heard"
for the sending agent, then output the status dashboard after any state change.

| First word | Source | Handler |
|---|---|---|
| `DONE` | implementer | [DONE handler](#done-ticket-id-branch) |
| `STATUS` | implementer | Log time; update dashboard (no state change) |
| `SHUTDOWN_ACK` | any | Record ack; continue shutdown sequence |
| `PASS` | AC verifier | [PASS handler](#pass-ticket-id) |
| `FAIL` | AC verifier | [FAIL handler](#fail-ticket-id) |
| `CLEAN` | quality reviewer | [CLEAN handler](#clean-ticket-id) |
| `REWORK` | quality reviewer | [REWORK handler](#rework-ticket-id) |
| `FINDINGS` | quality reviewer | [FINDINGS handler](#findings-ticket-id) |
| `OUT_OF_SCOPE` | implementer | [OUT_OF_SCOPE handler](#out_of_scope-n-reason) |

---

### DONE <ticket-id> <branch>

When implementer slot S sends `DONE <ticket-id> ticket/<ticket-id>`:

1. Set `ticket_state[ticket-id].state = IMPL_DONE`.
2. Push an AC verification job to the back of `ac_verification_queue` (FIFO
   by arrival time):
   ```
   ac_verification_queue.push({ ticket_id, branch: "ticket/<ticket-id>" })
   ```
3. Push a quality review job to the back of `quality_review_queue` (FIFO by
   arrival time). QR entries sit in the queue until AC passes — they are
   dispatched only after the ticket's AC phase completes:
   ```
   quality_review_queue.push({ ticket_id, branch: "ticket/<ticket-id>" })
   ```
4. **If the AC verifier is idle** (no ticket currently has
   `verification_phase == "ac"`), dispatch the head of `ac_verification_queue`:
   - Pop the head entry E.
   - `ticket_state[E.ticket_id].state = VERIFYING`
   - `ticket_state[E.ticket_id].verification_phase = "ac"`
   - Send:
     ```
     SendMessage({
       to: "dag-ac-verifier",
       message: "Verify <E.ticket_id> on branch <E.branch>. Run `tk show <E.ticket_id>` for acceptance criteria. Write detailed results as a note on the ticket, then return PASS or FAIL as the first word of your reply."
     })
     ```
5. Output dashboard.

> The implementer slot S **remains assigned** to `ticket-id` throughout AC and
> quality review. The slot is freed only after the ticket reaches CLOSED
> (handled by the merge + recycle protocol in the CLEAN handler below). If
> quality review returns REWORK, the implementer receives the rework assignment
> on the same slot S — the slot is never idle between DONE and CLOSED.

---

### PASS <ticket-id>

When the AC verifier sends `PASS <ticket-id>`:

1. Verify `ticket_state[ticket-id].verification_phase == "ac"`.
2. Set `ticket_state[ticket-id].verification_phase = null` (releases the AC
   verifier's "busy" signal regardless of what happens with QR).
3. Recycle the AC verifier (shutdown_request → SHUTDOWN_ACK → re-spawn →
   WORKTREE OK; see [Recycle protocol](#recycle-protocol-reference)). When the
   recycled AC verifier is ready:
   - If `ac_verification_queue` is non-empty, pop the head entry E and dispatch
     it (same as DONE step 4): set E's state to VERIFYING with phase "ac", send
     the verify message.
4. **If the quality reviewer is idle** (no ticket currently has
   `verification_phase == "quality"`), dispatch this ticket's QR job:
   - Find and remove `ticket-id`'s entry from `quality_review_queue`.
   - Find the idle QR slot (dag-qr-1 or dag-qr-2 — whichever is not currently
     processing a job).
   - `ticket_state[ticket-id].verification_phase = "quality"`
   - Send:
     ```
     SendMessage({
       to: "<idle-qr-slot>",
       message: "Review <ticket-id> on branch ticket/<ticket-id>. Changes passed AC verification.
     Diff against integration branch: git diff epic/<epic-id>...ticket/<ticket-id>

     Findings parent: <findings_parent>. Out-of-scope findings and Lows must use `--parent <findings_parent>` when creating tickets.

     Return one of:
       CLEAN — no blocking issues
       REWORK — numbered inline list of fixable findings
       FINDINGS — all blockers were out-of-scope; list the ticket IDs you created"
     })
     ```
5. **If the quality reviewer is busy**, leave `ticket-id`'s entry in
   `quality_review_queue`. The recycle handler in CLEAN/REWORK/FINDINGS
   (step 4 of each) will pop it naturally when the QR becomes available.
6. Output dashboard.

---

### FAIL <ticket-id>

When the AC verifier sends `FAIL <ticket-id> <detail>`:

1. Verify `ticket_state[ticket-id].verification_phase == "ac"`.
2. Increment `ac_fail_count[ticket-id]`.
3. Remove `ticket-id`'s entry from `quality_review_queue` (AC failed — the QR
   job is invalid; it will be re-enqueued when the implementer signals DONE
   again after rework).
4. Recycle the AC verifier (same procedure as PASS step 3). When ready, check
   `ac_verification_queue` and dispatch next if non-empty (same as PASS step 3).
5. If `ac_fail_count[ticket-id] >= 3`: escalate to the user. Do not dispatch
   rework until the user responds.

   > `<ticket-id>` has failed AC verification 3 times. Options:
   > 1. **Provide guidance** — I will include your guidance in the rework message
   > 2. **Reassign** — pick a different implementer (resets all counters)
   > 3. **Mark BLOCKED** — skip this ticket and continue with others

   - **Option 1 (guidance):** Include the user's text in the rework message at
     step 10. Reset `ac_fail_count[ticket-id] = 0` and continue to steps 6–11.
   - **Option 2 (reassign):** Reset `ac_fail_count[ticket-id] = 0` and
     `rework_count[ticket-id] = 0`. Run the
     [Worktree reset procedure](#worktree-reset-procedure) on slot S's worktree —
     **skip step 4** (`branch -D`); preserve the `ticket/<id>` branch so the new
     implementer in S' can check it out. Free slot S
     (`agent_pool[S].assignee = null`). Select a different idle slot S'; if none
     is idle, wait for one to free up. Re-dispatch the ticket to S' as a standard
     rework assignment.
   - **Option 3 (BLOCKED):**
     - `tk set <ticket-id> --status blocked`
     - Run the [Worktree reset procedure](#worktree-reset-procedure) on slot S's
       worktree — **do not** delete the `ticket/<id>` branch; leave it for
       post-run inspection.
     - `agent_pool[S].assignee = null`; slot S is now idle.
     - Identify downstream tickets: any ticket with a direct or transitive
       dependency on `<ticket-id>` will no longer appear in `tk ready`. Report
       these stalled tickets to the user.
     - Call `dispatch_ready_tickets()` to assign the freed slot to other work.
     - Output dashboard with `<ticket-id>` in BLOCKED state. **Skip steps 6–11.**

6. `ticket_state[ticket-id].state = REWORK`
7. `ticket_state[ticket-id].verification_phase = null`
8. Find the implementer slot S where `agent_pool[S].assignee == ticket-id`.
9. If `agent_pool[S].assignments_since_spawn >= RECYCLE_CAP`: recycle slot S
   before sending (see [Recycle protocol](#recycle-protocol-reference)).
10. Send:
    ```
    SendMessage({
      to: "<slot-S>",
      message: "AC verification failed for <ticket-id>. Run `tk show <ticket-id>` — the verifier wrote the specific failures as a note on the ticket. Fix, recommit, and signal DONE."
    })
    ```
11. Output dashboard.
12. **Livelock check.** If every slot in `agent_pool` has `assignee != null`
    and every assigned ticket has `state == REWORK`: log a livelock warning
    (see [Pool livelock](#pool-livelock) in Edge Cases) and continue waiting.

---

### CLEAN <ticket-id>

When a quality reviewer sends `CLEAN <ticket-id>`:

1. Verify `ticket_state[ticket-id].verification_phase == "quality"`.
2. `ticket_state[ticket-id].state = MERGING`
3. `ticket_state[ticket-id].verification_phase = null`
4. Recycle the quality reviewer (shutdown_request → SHUTDOWN_ACK → re-spawn →
   WORKTREE OK; see [Recycle protocol](#recycle-protocol-reference)). When the
   recycled quality reviewer is ready: check `quality_review_queue`. If
   non-empty and the head ticket has passed AC (verification_phase is not
   "ac"), pop the head and dispatch it (same as PASS step 4).
5. Acquire the merge lock and run the merge:
   - If `merge_lock` is non-null: append `ticket-id` to `merge_queue` and
     stop — this ticket will be merged when the lock is released.
   - Set `merge_lock = ticket-id`.
   - **Dirty-tree pre-flight:** abort if the main repo working tree is dirty:
     ```bash
     if [ -n "$(git -C $REPO_ROOT status --porcelain)" ]; then
       echo "ABORT: main repo working tree is dirty before merging <ticket-id>"
       git -C $REPO_ROOT status
       # release merge_lock, escalate to user — halt all further merges
     fi
     ```
     If the check fires: set `merge_lock = null`, report the dirty status to
     the user, and halt all further merges until they resolve it. Do not
     process the merge queue — the dirty tree must be cleaned first.
   - Run:
     ```bash
     git -C $REPO_ROOT checkout epic/<epic-id>
     git -C $REPO_ROOT merge ticket/<ticket-id> --no-ff -m "Merge <ticket-id>: <ticket title>"
     git -C $REPO_ROOT checkout main
     ```

   **On success (exit 0, no conflicts):**
   a. Set `ticket_state[ticket-id].state = MERGED`.
   b. Run `tk close <ticket-id>`.
   c. Set `ticket_state[ticket-id].state = CLOSED`; set
      `verification_phase = null`.
   d. Release merge lock: `merge_lock = null`.
   e. Run the [Worktree reset procedure](#worktree-reset-procedure) on slot
      S's worktree (`agent_pool[S].worktree`). If the reset verification
      fails (dirty status), mark slot S unavailable and report to the user —
      do not dispatch.
   f. Free the slot: `agent_pool[S].assignee = null`.
   g. If `merge_queue` is non-empty: pop the head entry `next-id`, set
      `merge_lock = next-id`, and run step 5 starting from the merge command
      for `next-id`.
   h. Call `dispatch_ready_tickets()`.

   **On conflict (non-zero exit or conflict markers):**
   a. Run `git -C $REPO_ROOT merge --abort` to clear MERGE_HEAD and
      conflict markers from the integration branch working tree.
   b. Release merge lock: `merge_lock = null`.
   c. Complete steps d–g below first (route the conflict ticket to rework),
      then if `merge_queue` is non-empty: pop the head entry `next-id`, set
      `merge_lock = next-id`, and run step 5 starting from the merge command
      for `next-id`.
   d. Set `ticket_state[ticket-id].state = REWORK`.
   e. Find slot S where `agent_pool[S].assignee == ticket-id`.
   f. If `agent_pool[S].assignments_since_spawn >= RECYCLE_CAP`: recycle
      slot S before sending (see [Recycle protocol](#recycle-protocol-reference)).
   g. Send the merge-conflict message to slot S:
      ```
      SendMessage({
        to: "<slot-S>",
        message: "Merge conflict when integrating <ticket-id> into epic/<epic-id>.
      The team lead has already run `git merge --abort` to clear the mid-merge state.

      In your worktree:
        git checkout epic/<epic-id>
        git merge ticket/<ticket-id>
        # resolve all conflicts, then:
        git add <resolved-files>
        git commit

      Signal DONE when the resolution is committed. The re-merge after validation
      will be a no-op by design."
      })
      ```
6. Output dashboard.

---

### REWORK <ticket-id> <findings>

When a quality reviewer sends `REWORK <ticket-id>` followed by a numbered
finding list:

1. Verify `ticket_state[ticket-id].verification_phase == "quality"`.
2. Increment `rework_count[ticket-id]`.
3. Recycle the quality reviewer (same procedure as CLEAN step 4). When ready,
   dispatch next from `quality_review_queue` if non-empty and head ticket has
   passed AC (same as CLEAN step 4).
4. If `rework_count[ticket-id] >= 3`: escalate to the user. Do not dispatch
   rework until the user responds.

   > `<ticket-id>` has failed quality review 3 times. Options:
   > 1. **Provide guidance** — I will include your guidance in the rework message
   > 2. **Reassign** — pick a different implementer (resets all counters)
   > 3. **Mark BLOCKED** — skip this ticket and continue with others

   - **Option 1 (guidance):** Include the user's text in the rework message at
     step 9. Reset `rework_count[ticket-id] = 0` and continue to steps 5–10.
   - **Option 2 (reassign):** Reset `rework_count[ticket-id] = 0` and
     `ac_fail_count[ticket-id] = 0`. Run the
     [Worktree reset procedure](#worktree-reset-procedure) on slot S's worktree —
     **skip step 4** (`branch -D`); preserve the `ticket/<id>` branch so the new
     implementer in S' can check it out. Free slot S
     (`agent_pool[S].assignee = null`). Select a different idle slot S'; if none
     is idle, wait for one to free up. Re-dispatch the ticket to S' as a standard
     rework assignment.
   - **Option 3 (BLOCKED):**
     - `tk set <ticket-id> --status blocked`
     - Run the [Worktree reset procedure](#worktree-reset-procedure) on slot S's
       worktree — **do not** delete the `ticket/<id>` branch.
     - `agent_pool[S].assignee = null`; slot S is now idle.
     - Identify and report stalled downstream tickets to the user.
     - Call `dispatch_ready_tickets()` to assign the freed slot to other work.
     - Output dashboard with `<ticket-id>` in BLOCKED state. **Skip steps 5–10.**

5. `ticket_state[ticket-id].state = REWORK`
6. `ticket_state[ticket-id].verification_phase = null`
7. Find the implementer slot S where `agent_pool[S].assignee == ticket-id`.
8. If `agent_pool[S].assignments_since_spawn >= RECYCLE_CAP`: recycle slot S
   before sending (see [Recycle protocol](#recycle-protocol-reference)).
9. Forward the numbered findings verbatim:
   ```
   SendMessage({
     to: "<slot-S>",
     message: "Quality review returned REWORK for <ticket-id>. Fix these findings in your branch and signal DONE again:

   <numbered finding list verbatim from QR message>

   If any finding is genuinely out of scope (would require touching files this ticket never named), reply with:
     OUT_OF_SCOPE <n>: <one-sentence reason>
   I will convert those to tickets. Fix every finding you do not push back on."
   })
   ```
10. Output dashboard.
11. **Livelock check.** If every slot in `agent_pool` has `assignee != null`
    and every assigned ticket has `state == REWORK`: log a livelock warning
    (see [Pool livelock](#pool-livelock) in Edge Cases) and continue waiting.

---

### FINDINGS <ticket-id>

When a quality reviewer sends `FINDINGS <ticket-id>` (all findings were
out-of-scope; the reviewer has already created finding tickets):

Treat identically to CLEAN — no inline rework is needed. Proceed from
[CLEAN step 1](#clean-ticket-id).

---

### OUT_OF_SCOPE <n>: <reason>

When an implementer sends one or more `OUT_OF_SCOPE` lines in response to a
REWORK message:

1. For each `OUT_OF_SCOPE <n>: <reason>` line:
   - Create a finding ticket:
     ```bash
     tk create "<reason>" -t task -p 3 --parent <findings_parent>
     ```
   - Record the new ticket ID in the dashboard.
2. Remove the pushed-back finding numbers from the pending rework list for
   `ticket-id`.
3. **If inline findings remain** (at least one was not pushed back):
   - Re-send the remaining findings (renumbered from 1) to slot S:
     ```
     SendMessage({
       to: "<slot-S>",
       message: "Quality review REWORK — remaining findings after OUT_OF_SCOPE acknowledgement for <ticket-id>:

     <renumbered remaining finding list>

     Fix these and signal DONE."
     })
     ```
4. **If all findings were pushed back** (every finding was OUT_OF_SCOPE):
   - No inline rework remains. Treat as CLEAN: proceed to MERGING
     ([CLEAN step 2](#clean-ticket-id)).
5. Output dashboard.

---

### Dispatch helper — assign next ready ticket to an idle slot

Call `dispatch_ready_tickets()` whenever a slot is freed (post-CLOSED) and
after the initial Phase 2 worktree-OK confirmation. This procedure is also
the entry point called by the CLEAN handler (merge protocol) after each `tk close`.

```
procedure dispatch_ready_tickets():
  # Re-query tk ready filtered to this epic's children
  run: tk ready
  filter: .parent == "<epic-id>"
  → fresh_ready (ticket IDs not yet DISPATCHED/in-flight)

  for each idle implementer slot S (agent_pool[S].assignee == null):
    T = next ticket from fresh_ready not yet in ticket_state
    if no such T exists: break

    ticket_state[T] = { state: DISPATCHED, verification_phase: null }
    ac_fail_count[T] = 0
    rework_count[T] = 0
    agent_pool[S].assignee = T
    agent_pool[S].assignments_since_spawn += 1
    if assignments_since_spawn >= RECYCLE_CAP:
      # Recycle S before sending: shutdown_request → SHUTDOWN_ACK → re-spawn
      # (same Agent call, same worktree path) → WORKTREE OK.
      # Then: assignments_since_spawn = 1  (this dispatch is the new agent's first)
      # See Recycle protocol section for full procedure.
    SendMessage({
      to: "<S>",
      message: "Ticket <T>: <T title>

Implement this ticket. Branch:
  git show-ref --verify --quiet refs/heads/ticket/<T> && git checkout ticket/<T> || git checkout -b ticket/<T> epic/<epic-id>

Run `tk show <T>` for full context. Signal DONE when committed."
    })

  output dashboard
```

This procedure re-queries `tk ready` on every call so that tickets whose last
blocker just closed appear immediately — no shadow DAG is maintained.

---

### Worktree reset procedure

Run this after every ticket CLOSED transition, before freeing the slot.
`<completed-id>` is the ticket just closed; `<worktree>` is `agent_pool[S].worktree`.

```bash
# 1. Checkout the merge target (integration branch)
git -C <worktree> checkout epic/<epic-id>

# 2. Hard-reset to HEAD of the integration branch
git -C <worktree> reset --hard epic/<epic-id>

# 3. Remove untracked files and directories
git -C <worktree> clean -fd

# 4. Remove the stale ticket branch from this worktree
git -C <worktree> branch -D ticket/<completed-id> 2>/dev/null || true

# 5. Verify clean before the next ticket is dispatched
git -C <worktree> status --porcelain   # must produce empty output
```

If step 5 produces any output, the team lead does **not** dispatch the next
ticket to this slot. It marks the slot unavailable and reports the dirty
status to the user.

---

## Phase 4 — Epic completion

When all child tickets of the epic have reached CLOSED or BLOCKED state:

1. Report to the user:
   ```
   Epic <epic-id> complete. N tickets closed, M tickets blocked.

   Closed tickets:
     [<id>] <title> — merged to epic/<epic-id>
     ...

   Blocked tickets (stalled, not merged):
     [<id>] <title>
     ...

   Integration branch: epic/<epic-id>

   Next steps:
     1. Run deep review: /multi-review git diff main epic/<epic-id> --
     2. Address any critical/high findings
     3. Merge to main: git checkout main && git merge epic/<epic-id> --no-ff
   ```

2. If non-blocking finding tickets remain open, list them:
   ```
   Non-blocking findings left open (tracked as tk tickets):
     <finding-ticket-ids>
   ```

3. Broadcast `shutdown_request` to all teammates:
   ```
   SendMessage({ to: "dag-impl-1",      message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-impl-2",      message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-impl-3",      message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-impl-4",      message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-ac-verifier", message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-qr-1",        message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-qr-2",        message: { "type": "shutdown_request" } })
   ```

4. Wait up to 30 seconds for `SHUTDOWN_ACK` from each teammate. Proceed after
   timeout — agents should already be idle.

5. Remove all worktrees:
   ```bash
   for N in 1 2 3 4; do
     git worktree remove .worktrees/epic-dag-$STAMP-impl-$N --force 2>/dev/null || true
   done
   git worktree remove .worktrees/epic-dag-$STAMP-ac-verifier --force 2>/dev/null || true
   git worktree remove .worktrees/epic-dag-$STAMP-qr-1        --force 2>/dev/null || true
   git worktree remove .worktrees/epic-dag-$STAMP-qr-2        --force 2>/dev/null || true
   ```

6. Call `TeamDelete()`.

---

## Edge Cases

### Pool livelock

Livelock condition: all implementer slots have `assignee != null` and every
assigned ticket is in REWORK state, meaning no slot can accept new ready work.

Detection: after any REWORK dispatch (FAIL handler step 12, REWORK handler
step 11), if every `agent_pool` slot is occupied and every assigned ticket is
in REWORK state, livelock is active.

Resolution:
1. Do **not** spawn extra implementers.
2. Log the livelock condition to the user, listing pinned tickets and any
   queued-but-undispatched tickets from `ready_queue`:
   > Pool livelock: all N implementer slots are pinned in rework.
   > Pinned: <ticket-ids>. Waiting for rework cycles to complete.
3. Continue waiting. As each rework cycle completes (implementer sends DONE),
   the slot frees and accepts the next item from `ready_queue`.
4. If no progress for >15 min, perform a heartbeat sweep: send a one-line
   status check via `SendMessage` to each busy implementer; call `TaskOutput`
   against each implementer's task to inspect recent tool output; report the
   findings in the dashboard under event header `heartbeat: livelock stall`.
   If any agent appears unresponsive, escalate to the user.

### Stuck agents

If any agent is marked busy and you have not received a message from anyone
in ~5 minutes, actively sweep: send a one-line status check via `SendMessage`
to each busy agent. If a specific agent has been busy on the same task for
~15 minutes without a progress message, call `TaskOutput` against its task to
inspect what it is actually doing. Report findings in the next dashboard update
under event header `heartbeat sweep`. If any agent appears truly unresponsive
(no tool output in 15 min), escalate to the user.

**STATUS is not DONE.** Implementers send STATUS mid-ticket. `SendMessage` ends
the sender's turn, so an implementer that sends STATUS and goes idle has not
finished — it is waiting for acknowledgement. If an implementer is idle and its
last message was STATUS, immediately send `continue working on <ticket-id>`.

### Partial shutdown (user stops mid-run)

1. Broadcast `shutdown_request` to all teammates.
2. Wait up to 30 seconds for `SHUTDOWN_ACK` from each.
3. Call `TeamDelete()`.

In-progress tickets remain marked in-progress in `tk`. The user can resume
by running `/run-epic-dag` again — in-progress tickets will be re-claimable.

### Dirty working tree guard

The main repo's working tree must stay clean for the entire run. The
CLEAN handler pre-flight (`git status --porcelain` before each merge) catches
any corruption since the last successful merge — typically caused by a sandboxed
agent that ran `git checkout` or `git stash` in the main repo instead of its own
worktree. Do not try to auto-recover. Stop further merges, report to the user
with the offending status output, and let the user triage.

The Phase 1.1 stash-list guard and per-agent worktrees prevent the root cause.
This guard catches any new variant of the same class of bug.

---

## Recycle protocol (reference)

Before dispatching any work message to an implementer, check
`assignments_since_spawn`. If `>= RECYCLE_CAP (3)`, recycle first:

1. `SendMessage({ to: "<slot>", message: { type: "shutdown_request" } })`
2. Wait up to 30 s for `SHUTDOWN_ACK <slot>`.
3. Verify team lead CWD is still `REPO_ROOT`.
4. Re-spawn with the **exact same Agent call** used at startup: same `name`,
   same `subagent_type`, no `isolation: "worktree"` (worktree already exists).
   For the worktree path in the prompt:
   - **Implementer slots** (`dag-impl-1` .. `dag-impl-4`): read from
     `agent_pool[slot].worktree`
     (e.g. `$REPO_ROOT/.worktrees/epic-dag-$STAMP-impl-2`).
   - **AC verifier and QR slots** (`dag-ac-verifier`, `dag-qr-1`, `dag-qr-2`):
     not tracked in `agent_pool` — derive from the stamp as
     `$REPO_ROOT/.worktrees/epic-dag-$STAMP-ac-verifier`,
     `$REPO_ROOT/.worktrees/epic-dag-$STAMP-qr-1`, or
     `$REPO_ROOT/.worktrees/epic-dag-$STAMP-qr-2`, matching the paths
     created in Step 1.2.
5. Wait for `WORKTREE OK`. Wrong path or `WARNING` aborts the run.
6. Reset `assignments_since_spawn = 0`.

AC verifier and quality reviewers recycle after **every** verdict (both PASS
and FAIL, both CLEAN/REWORK/FINDINGS). Same procedure: shutdown_request →
SHUTDOWN_ACK → re-spawn same Agent call → WORKTREE OK.

---

## Status dashboard format

Output a status dashboard every time agent or ticket state changes.

```
── <event description> ──────────────────────────────────

**Agents**

| Agent          | State         | Working on              | Last heard |
|---|---|---|---|
| dag-impl-1     | implementing  | [cc-1abc] Add endpoint  | 14:29:47   |
| dag-impl-2     | idle          |                         | 14:30:55   |
| dag-impl-3     | idle          |                         |            |
| dag-impl-4     | idle          |                         |            |
| dag-ac-verifier| idle          |                         | 14:31:02   |
| dag-qr-1       | reviewing     | [cc-1abc]               | 14:32:11   |
| dag-qr-2       | idle          |                         |            |

**Tickets**

| Ticket                    | State      | Notes          |
|---|---|---|
| [cc-1abc] Add endpoint    | VERIFYING  | AC pass #1     |
| [cc-2def] Fix login       | DISPATCHED |                |
| [cc-3ghi] Add logout      | BLOCKED    | waiting cc-2def|

Progress: 0/3 closed

────────────────────────────────────────────────────────
```

Prefix all inbound teammate messages with the local clock time received and
update the "Last heard" cell for that agent.
