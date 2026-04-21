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

## Phase 3 — Event loop (placeholder)

<!-- Event loop logic is implemented in tickets cc-sw6p (dispatch + state
     tracking), cc-dhvk (merge queue + recycle), and cc-euin (edge cases,
     stuck-agent handling, shutdown). This section will be replaced when
     those tickets are merged. -->

**[TODO: cc-sw6p]** Message routing: handle DONE, STATUS, OUT_OF_SCOPE from
implementers; PASS/FAIL from AC verifier; CLEAN/REWORK/FINDINGS from quality
reviewers. Drive all ticket state transitions per the DAG Execution Design.

**[TODO: cc-dhvk]** Merge queue: acquire/release merge_lock, FIFO merge
serialization, implementer recycle (RECYCLE_CAP = 3), worktree reset between
tickets.

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
   same `subagent_type`, same `worktree` path from `agent_pool[slot].worktree`,
   no `isolation: "worktree"` (worktree already exists).
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
