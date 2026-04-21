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
  # worktree: "<REPO_ROOT>/.worktrees/dag-impl-<N>"

ac_verification_queue: Queue<{ticket_id, branch}>   # FIFO
quality_review_queue:  Queue<{ticket_id, branch}>   # FIFO

merge_lock: ticket_id | null
merge_queue: List<ticket_id>     # ordered waiting list

wave_number: int = 1
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
REPO_ROOT=$(pwd)
git checkout -b epic/<epic-id> main
git checkout main
```

Pre-flight the main repo state before proceeding:

```bash
git -C $REPO_ROOT status --porcelain   # must be empty
git -C $REPO_ROOT stash list            # must be empty
```

If either produces output, stop and report to the user — do not auto-clean.

### Step 1.2: Pre-create worktrees for all agents

Implementer worktrees use **deterministic paths** with no stamp suffix so they
can be referenced by name across recycle cycles without coordination overhead.

```bash
# 4 implementer worktrees
worktree-init dag-impl-1 $REPO_ROOT
worktree-init dag-impl-2 $REPO_ROOT
worktree-init dag-impl-3 $REPO_ROOT
worktree-init dag-impl-4 $REPO_ROOT

# 1 AC verifier worktree
worktree-init dag-ac-verifier $REPO_ROOT

# 2 quality reviewer worktrees
worktree-init dag-qr-1 $REPO_ROOT
worktree-init dag-qr-2 $REPO_ROOT
```

Verify all were created: `ls .worktrees/` must show all 7 directories.

Register worktree paths in `agent_pool`:

```
agent_pool["dag-impl-1"].worktree = "$REPO_ROOT/.worktrees/dag-impl-1"
agent_pool["dag-impl-2"].worktree = "$REPO_ROOT/.worktrees/dag-impl-2"
agent_pool["dag-impl-3"].worktree = "$REPO_ROOT/.worktrees/dag-impl-3"
agent_pool["dag-impl-4"].worktree = "$REPO_ROOT/.worktrees/dag-impl-4"
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

WORKTREE: <REPO_ROOT>/.worktrees/dag-impl-<N>

Before doing anything else, run this single Bash call to set your CWD
and verify isolation:
\`\`\`
cd <REPO_ROOT>/.worktrees/dag-impl-<N> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
\`\`\`
Report the pwd output and result to the team lead via SendMessage.

All tool calls MUST target your worktree, not the main repo:
- Bash: your CWD is already set — just run commands directly
- Read/Edit: absolute paths starting with <REPO_ROOT>/.worktrees/dag-impl-<N>/
- Glob/Grep: pass path=<REPO_ROOT>/.worktrees/dag-impl-<N>
Never reference <REPO_ROOT> without the .worktrees/dag-impl-<N> suffix.

Git: your CWD is already the worktree — always use plain \`git\` with no -C flag.
Never use \`git -C <path>\` in implementer code; that is reserved for the team lead.

Then wait for the team lead to assign you a ticket via SendMessage. Do NOT
claim tickets from the task list — the team lead routes all work.

For each ticket assignment:
1. Check out the ticket branch — resume if it exists, otherwise branch fresh
   from the latest integration state:
   \`git checkout ticket/<ticket-id> 2>/dev/null || git checkout -b ticket/<ticket-id> epic/<epic-id>\`
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

WORKTREE: <REPO_ROOT>/.worktrees/dag-ac-verifier

Before doing anything else, run this single Bash call to set your CWD
and verify isolation:
\`\`\`
cd <REPO_ROOT>/.worktrees/dag-ac-verifier && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
\`\`\`
Report the result to the team lead via SendMessage.

All Bash/Read/Edit/Glob/Grep calls MUST target your worktree. Never
reference <REPO_ROOT> without the .worktrees/dag-ac-verifier suffix.
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

WORKTREE: <REPO_ROOT>/.worktrees/dag-qr-<K>

Before doing anything else, run this single Bash call to set your CWD
and verify isolation:
\`\`\`
cd <REPO_ROOT>/.worktrees/dag-qr-<K> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
\`\`\`
Report the result to the team lead via SendMessage.

All Bash/Read/Edit/Glob/Grep calls MUST target your worktree. Never
reference <REPO_ROOT> without the .worktrees/dag-qr-<K> suffix.
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
  git checkout ticket/<ticket-id> 2>/dev/null || git checkout -b ticket/<ticket-id> epic/<epic-id>

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
> (handled by the merge + recycle protocol in [TODO: cc-dhvk]). If quality
> review returns REWORK, the implementer receives the rework assignment on the
> same slot S — the slot is never idle between DONE and CLOSED.

---

### PASS <ticket-id>

When the AC verifier sends `PASS <ticket-id>`:

1. Verify `ticket_state[ticket-id].verification_phase == "ac"`.
2. **[TODO: cc-dhvk]** Recycle the AC verifier (shutdown_request → SHUTDOWN_ACK
   → re-spawn → WORKTREE OK). When the recycled AC verifier is ready:
   - If `ac_verification_queue` is non-empty, pop the head entry E and dispatch
     it (same as DONE step 4): set E's state to VERIFYING with phase "ac", send
     the verify message.
3. Find and remove `ticket-id`'s entry from `quality_review_queue`.
4. **If the quality reviewer is idle** (no ticket currently has
   `verification_phase == "quality"`), dispatch this ticket's QR job immediately:
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
5. **If the quality reviewer is busy**, the job stays removed from the queue.
   It will be re-dispatched when the QR finishes its current job and recycles
   (the recycle handler checks for the next queued job).
6. Output dashboard.

---

### FAIL <ticket-id>

When the AC verifier sends `FAIL <ticket-id> <detail>`:

1. Verify `ticket_state[ticket-id].verification_phase == "ac"`.
2. Increment `ac_fail_count[ticket-id]`.
3. Remove `ticket-id`'s entry from `quality_review_queue` (AC failed — the QR
   job is invalid; it will be re-enqueued when the implementer signals DONE
   again after rework).
4. **[TODO: cc-dhvk]** Recycle the AC verifier. When ready, check
   `ac_verification_queue` and dispatch next if non-empty (same as PASS step 2).
5. **[TODO: cc-euin]** If `ac_fail_count[ticket-id] >= 3`: escalate to user
   (options: provide guidance / reassign / mark BLOCKED). Do not dispatch rework.
6. `ticket_state[ticket-id].state = REWORK`
7. `ticket_state[ticket-id].verification_phase = null`
8. Find the implementer slot S where `agent_pool[S].assignee == ticket-id`.
9. **[TODO: cc-dhvk]** If `agent_pool[S].assignments_since_spawn >= RECYCLE_CAP`:
   recycle slot S before sending the rework message.
10. Send:
    ```
    SendMessage({
      to: "<slot-S>",
      message: "AC verification failed for <ticket-id>. Run `tk show <ticket-id>` — the verifier wrote the specific failures as a note on the ticket. Fix, recommit, and signal DONE."
    })
    ```
11. Output dashboard.

---

### CLEAN <ticket-id>

When a quality reviewer sends `CLEAN <ticket-id>`:

1. Verify `ticket_state[ticket-id].verification_phase == "quality"`.
2. `ticket_state[ticket-id].state = MERGING`
3. `ticket_state[ticket-id].verification_phase = null`
4. **[TODO: cc-dhvk]** Recycle the quality reviewer. When ready, check
   `quality_review_queue`. If non-empty and the head ticket has passed AC
   (verification_phase is not "ac"), pop the head and dispatch it (same as
   PASS step 4).
5. **[TODO: cc-dhvk]** Acquire merge_lock; run:
   ```bash
   git -C $REPO_ROOT checkout epic/<epic-id>
   git -C $REPO_ROOT merge ticket/<ticket-id> --no-ff -m "Merge <ticket-id>: <ticket title>"
   ```
   On success: set `ticket_state[ticket-id].state = MERGED`; run `tk close
   <ticket-id>`; set state to CLOSED; release merge_lock; run
   `dispatch_ready_tickets()` (see below). On conflict: see Merge Queue conflict
   handling in cc-dhvk.
6. Output dashboard.

---

### REWORK <ticket-id> <findings>

When a quality reviewer sends `REWORK <ticket-id>` followed by a numbered
finding list:

1. Verify `ticket_state[ticket-id].verification_phase == "quality"`.
2. Increment `rework_count[ticket-id]`.
3. **[TODO: cc-dhvk]** Recycle the quality reviewer. When ready, dispatch next
   from `quality_review_queue` if non-empty and head ticket has passed AC
   (same as CLEAN step 4).
4. **[TODO: cc-euin]** If `rework_count[ticket-id] >= 3`: escalate to user
   (options: provide guidance / reassign / mark BLOCKED). Do not dispatch rework.
5. `ticket_state[ticket-id].state = REWORK`
6. `ticket_state[ticket-id].verification_phase = null`
7. Find the implementer slot S where `agent_pool[S].assignee == ticket-id`.
8. **[TODO: cc-dhvk]** If `agent_pool[S].assignments_since_spawn >= RECYCLE_CAP`:
   recycle slot S before sending the rework message.
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
the entry point called by the cc-dhvk merge protocol after each `tk close`.

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
    # [TODO: cc-dhvk] If assignments_since_spawn >= RECYCLE_CAP: recycle S
    #   before sending (shutdown_request → SHUTDOWN_ACK → re-spawn → WORKTREE OK;
    #   reset assignments_since_spawn = 0).
    SendMessage({
      to: "<S>",
      message: "Ticket <T>: <T title>

Implement this ticket. Branch:
  git checkout ticket/<T> 2>/dev/null || git checkout -b ticket/<T> epic/<epic-id>

Run `tk show <T>` for full context. Signal DONE when committed."
    })

  output dashboard
```

This procedure re-queries `tk ready` on every call so that tickets whose last
blocker just closed appear immediately — no shadow DAG is maintained.

---

**[TODO: cc-dhvk]** Merge queue: acquire/release merge_lock, FIFO merge
serialization, implementer recycle (RECYCLE_CAP = 3), worktree reset between
tickets, slot release after CLOSED, call `dispatch_ready_tickets()` post-close.

**[TODO: cc-euin]** Edge cases: AC fail escalation (>= 3), QR rework
escalation (>= 3), BLOCKED ticket handling, pool livelock detection, stuck-
agent heartbeat, partial shutdown on user stop request, epic completion report.

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
     `agent_pool[slot].worktree` (e.g. `$REPO_ROOT/.worktrees/dag-impl-2`).
   - **AC verifier and QR slots** (`dag-ac-verifier`, `dag-qr-1`, `dag-qr-2`):
     not tracked in `agent_pool` — use `$REPO_ROOT/.worktrees/<slot-name>`
     directly (e.g. `$REPO_ROOT/.worktrees/dag-qr-1`), matching the
     deterministic names assigned in Step 1.2.
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
