---
name: fix-tickets-dag
description: >
  Implement a set of tk tickets in parallel using a DAG-driven agent team with
  continuous dispatching. Spawns a fixed pool of 4 implementers and 2 quality
  reviewers at startup; dispatches tickets as they unblock without wave boundaries.
  Quality review is the sole verification gate — no AC verifier. Accepts the same
  ticket-ID and epic-ID argument forms as /fix-tickets. Use when the user says
  "fix tickets dag", "batch fix dag", "run fix tickets with dag", or similar.
argument-hint: "<ticket-id> [ticket-id ...] | <epic-id>"
---

# Fix Tickets DAG

You are the team lead for a DAG-driven fix-tickets execution. You orchestrate a
fixed agent pool against a continuously-dispatched ticket queue. You never
implement, never review, never make judgment calls about code. You dispatch
work, route validation results, manage state transitions, and recycle agents
as needed.

This skill is a variant of `/run-epic-dag` with these differences:
- **No AC verifier.** Quality review is the sole verification gate.
- **Ticket sourcing** follows `/fix-tickets` argument parsing: accepts a list
  of ticket IDs or a single epic ID (expanded into its open children).
- **Branch naming** uses `fix/<ticket-id>` and integration branch
  `fix/batch-<stamp>` (not `epic/<id>`).
- **Session epic** is created with the `fix-tickets-dag-*-<stamp>` title
  pattern when input tickets have mixed or no parents.

---

## Phase 0 — Parse arguments and load tickets

Parse `$ARGUMENTS`. Accept:
- One or more ticket IDs: `fix-tickets-dag cc-1 cc-2 cc-3`
- A single epic ID: pulls all non-closed, non-in-progress children

If no arguments, show usage and stop:
```
Usage: /fix-tickets-dag <ticket-id> [ticket-id ...] | <epic-id>
```

Load all tickets:
```bash
tk show-multi <ids>
# or, for an epic:
tk query '.parent == "<epic-id>"'
```

Filter out any tickets with status `closed` or `in_progress`. If nothing
remains, tell the user and stop.

Check for ready (unblocked) tickets using `tk ready`. If none of the
remaining tickets are unblocked, report:

> No unblocked tickets found. Check `tk blocked` to see what is holding
> things up. The run cannot proceed until at least one ticket is unblocked.

Stop — do not create the team.

Mark all remaining (non-closed, non-in-progress) tickets as in-progress
immediately, before planning or confirmation, so concurrent runs cannot
claim the same tickets:

```bash
tk start <ticket-id>
# repeat for each ticket
```

### Findings parent epic

Establish a `FINDINGS_PARENT` epic ID for out-of-scope finding tickets.

Inspect the `.parent` field of every input ticket and pick the rule that
applies:

- **All input tickets share the same non-empty parent** (covers both "user
  passed an epic ID" and "user passed a filtered subset of one epic's
  children"): reuse it. `FINDINGS_PARENT = <that shared parent id>`. No new
  epic is created.

- **Input tickets have mixed or no parents:** create a fresh session epic:
  ```bash
  STAMP=$(date +%Y%m%d-%H%M%S)
  FINDINGS_PARENT=$(tk create "fix-tickets-dag-batch-$STAMP" -t epic -p 2 \
    -d "Session epic for /fix-tickets-dag run over <N> tickets: <input-ticket-ids>")
  ```

Tell the user which branch you took in one line:

```
Findings parent: <FINDINGS_PARENT> (<reused existing epic | created session epic fix-tickets-dag-batch-<stamp>>)
```

Record `FINDINGS_PARENT` — pass it in every quality-reviewer routing message.

### In-memory state

Initialize the following structures before creating the team:

```
ticket_state: Map<ticket_id, TicketState>
  # state: DISPATCHED | IMPL_DONE | VERIFYING | REWORK | MERGING | MERGED | CLOSED | BLOCKED
  # verification_phase: "quality" | null

agent_pool: Map<slot_name, AgentSlot>
  # slot_name: "dag-impl-1" .. "dag-impl-4"
  # assignee: ticket_id | null
  # assignments_since_spawn: int
  # worktree: "<REPO_ROOT>/.worktrees/fix-dag-<stamp>-impl-<N>"

qr_pool: Map<slot_name, QRSlot>
  # slot_name: "dag-qr-1" | "dag-qr-2"
  # assignee: ticket_id | null   # null = idle

quality_review_queue: Queue<{ticket_id, branch}>   # FIFO

merge_lock: ticket_id | null
merge_queue: List<ticket_id>     # ordered waiting list

findings_parent: ticket_id = FINDINGS_PARENT

rework_count:    Map<ticket_id, int>  # reset to 0 on user-guidance rework
total_qr_rounds: Map<ticket_id, int>  # NEVER reset; counts every QR review
                                      # (CLEAN/REWORK/FINDINGS) for the ticket
                                      # across the entire run

RECYCLE_CAP = 3
TOTAL_QR_ROUNDS_CAP = 5               # hard ceiling independent of rework_count
```

### Startup summary

Present a summary to the user:

```
Tickets: N total, M ready (unblocked), K in-progress, J closed

Ready tickets:
  [<id>] <title>
  ...

Blocked tickets:
  [<id>] <title> (blocked by: <dep-ids>)
  ...

Pool: 4 implementers · 2 quality reviewers (no AC verifier)
Findings parent: <FINDINGS_PARENT>
```

Then confirm via `AskUserQuestion`:

```
AskUserQuestion({
  questions: [{
    question: "Proceed with DAG execution for these tickets?",
    header: "Fix tickets (DAG)",
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
git checkout -b fix/batch-$STAMP main
git checkout main
```

Pre-flight the main repo state before proceeding:

```bash
git -C $REPO_ROOT status --porcelain   # must be empty
git -C $REPO_ROOT stash list            # must be empty
```

If either produces output, stop and report to the user — do not auto-clean.

### Step 1.2: Pre-create worktrees for all agents

Worktree directory names are **stamp-scoped** so that multiple concurrent
`/fix-tickets-dag` runs in the same repo never share worktrees. The stamp
from Phase 1.1 is reused here. Agent slot names (`dag-impl-1` etc.) stay
short because they are scoped by `team_name` — only filesystem paths need
the stamp.

```bash
# 4 implementer worktrees
worktree-init fix-dag-$STAMP-impl-1 $REPO_ROOT
worktree-init fix-dag-$STAMP-impl-2 $REPO_ROOT
worktree-init fix-dag-$STAMP-impl-3 $REPO_ROOT
worktree-init fix-dag-$STAMP-impl-4 $REPO_ROOT

# 2 quality reviewer worktrees
worktree-init fix-dag-$STAMP-qr-1 $REPO_ROOT
worktree-init fix-dag-$STAMP-qr-2 $REPO_ROOT
```

Verify all were created: `ls .worktrees/` must show all 6 `fix-dag-$STAMP-*`
directories.

Register worktree paths in `agent_pool`:

```
agent_pool["dag-impl-1"].worktree = "$REPO_ROOT/.worktrees/fix-dag-$STAMP-impl-1"
agent_pool["dag-impl-2"].worktree = "$REPO_ROOT/.worktrees/fix-dag-$STAMP-impl-2"
agent_pool["dag-impl-3"].worktree = "$REPO_ROOT/.worktrees/fix-dag-$STAMP-impl-3"
agent_pool["dag-impl-4"].worktree = "$REPO_ROOT/.worktrees/fix-dag-$STAMP-impl-4"
```

### Step 1.3: Create the team

```
TeamCreate({
  team_name: "fix-dag-<stamp>",
  description: "DAG-driven fix team: <N> tickets, stamp <stamp>"
})
```

### Step 1.4: Create initial tasks

Create a task for each ready ticket (up to 4):

```
TaskCreate({
  subject: "Implement <ticket-id>: <ticket title>",
  description: "Run `tk show <ticket-id>` for full context. Implement,
  write tests, ensure tests pass, commit, then message the team lead
  when done."
})
```

### Step 1.5: Spawn teammates

Spawn all agents using the `Agent` tool with `team_name: "fix-dag-<stamp>"`.
All 4 implementers and both quality reviewers are spawned at startup
regardless of the number of ready tickets — excess implementers will be
idle until work arrives.

**Implementers** (spawn all 4 unconditionally):

For each slot N in 1..4:

```
Agent({
  subagent_type: "implementer",
  team_name: "fix-dag-<stamp>",
  name: "dag-impl-<N>",
  prompt: "You are an implementer on a team.

WORKTREE: <REPO_ROOT>/.worktrees/fix-dag-<stamp>-impl-<N>

Before doing anything else, run this single Bash call to set your CWD
and verify isolation:
\`\`\`
cd <REPO_ROOT>/.worktrees/fix-dag-<stamp>-impl-<N> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
\`\`\`
Report the pwd output and result to the team lead via SendMessage.

All tool calls MUST target your worktree, not the main repo:
- Bash: your CWD is already set — just run commands directly
- Read/Edit: absolute paths starting with <REPO_ROOT>/.worktrees/fix-dag-<stamp>-impl-<N>/
- Glob/Grep: pass path=<REPO_ROOT>/.worktrees/fix-dag-<stamp>-impl-<N>
Never reference <REPO_ROOT> without the .worktrees/fix-dag-<stamp>-impl-<N> suffix.

Git: your CWD is already the worktree — always use plain \`git\` with no -C flag.
Never use \`git -C <path>\` in implementer code; that is reserved for the team lead.

Then wait for the team lead to assign you a ticket via SendMessage. Do NOT
claim tickets from the task list — the team lead routes all work.

For each ticket assignment:
1. Check out the ticket branch — resume if it exists, otherwise branch fresh
   from the latest integration state:
   \`git checkout fix/<ticket-id> 2>/dev/null || git checkout -b fix/<ticket-id> fix/batch-<stamp>\`
2. Run \`tk show <ticket-id>\` for full context
3. Send STATUS to team lead: 'STATUS dag-impl-<N>: read <ticket-id>, starting implementation'
4. Implement the fix
5. Send STATUS to team lead: 'STATUS dag-impl-<N>: implementation done on <ticket-id>, running tests'
6. Run tests from your worktree
7. Commit to fix/<ticket-id>
8. Message the team lead: DONE <ticket-id> fix/<ticket-id>

Then wait for your next assignment. When you receive a message containing
'type: shutdown_request', reply with SHUTDOWN_ACK dag-impl-<N> then stop."
})
```

**Quality reviewers** (2 instances):

For each slot K in 1..2:

```
Agent({
  subagent_type: "quality-reviewer",
  team_name: "fix-dag-<stamp>",
  name: "dag-qr-<K>",
  prompt: "You are a quality reviewer on a team.

WORKTREE: <REPO_ROOT>/.worktrees/fix-dag-<stamp>-qr-<K>

Before doing anything else, run this single Bash call to set your CWD
and verify isolation:
\`\`\`
cd <REPO_ROOT>/.worktrees/fix-dag-<stamp>-qr-<K> && pwd && [ -f .git ] && echo 'WORKTREE OK' || echo 'WARNING: not in worktree'
\`\`\`
Report the result to the team lead via SendMessage.

All Bash/Read/Edit/Glob/Grep calls MUST target your worktree. Never
reference <REPO_ROOT> without the .worktrees/fix-dag-<stamp>-qr-<K> suffix.
Git: your CWD is already the worktree — use plain \`git\` with no -C flag.

Wait for the team lead to send you a ticket to review. Do not claim tasks
from the task list. After you return your verdict (CLEAN, REWORK, or
FINDINGS), you will be recycled — wait for the shutdown_request and reply
with SHUTDOWN_ACK dag-qr-<K> then stop."
})
```

---

## Phase 2 — Verify worktree isolation

After spawning all 6 agents, wait for `WORKTREE OK` from every teammate.
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
  git checkout fix/<ticket-id> 2>/dev/null || git checkout -b fix/<ticket-id> fix/batch-<stamp>

Run \`tk show <ticket-id>\` for full context. Signal DONE when committed."
})
```

Set `agent_pool["dag-impl-<N>"].assignee = <ticket-id>`,
`assignments_since_spawn += 1`, and `ticket_state[<ticket-id>].state = DISPATCHED`.

If fewer than 4 ready tickets exist, the remaining implementer slots stay
idle (assignee = null). They will receive work as tickets unblock during
the run.

---

## Phase 3 — Event loop

Process incoming messages from all agents and drive ticket state
transitions. The loop continues until every input ticket reaches CLOSED
or BLOCKED.

### Message routing

Inspect the **first word** of every incoming message and route to the
handler below. On every message arrival: record the current clock time as
"Last heard" for the sending agent, then output the status dashboard after
any state change.

| First word | Source | Handler |
|---|---|---|
| `DONE` | implementer | [DONE handler](#done-ticket-id-branch) |
| `STATUS` | implementer | Log time; update dashboard (no state change) |
| `SHUTDOWN_ACK` | any | Record ack; continue shutdown sequence |
| `CLEAN` | quality reviewer | [CLEAN handler](#clean-ticket-id) |
| `REWORK` | quality reviewer | [REWORK handler](#rework-ticket-id) |
| `FINDINGS` | quality reviewer | [FINDINGS handler](#findings-ticket-id) |
| `OUT_OF_SCOPE` | implementer | [OUT_OF_SCOPE handler](#out_of_scope-n-reason) |

---

### DONE <ticket-id> <branch>

When implementer slot S sends `DONE <ticket-id> fix/<ticket-id>`:

1. Set `ticket_state[ticket-id].state = IMPL_DONE`.
2. Push a quality review job to the back of `quality_review_queue` (FIFO
   by arrival time):
   ```
   quality_review_queue.push({ ticket_id, branch: "fix/<ticket-id>" })
   ```
3. **If a quality reviewer is idle** (count of tickets with
   `verification_phase == "quality"` is less than 2), dispatch the head
   of `quality_review_queue`:
   - Pop the head entry E.
   - Find the idle QR slot: `qr_pool` entry where `assignee == null`
     (dag-qr-1 or dag-qr-2 — whichever is not currently processing a job).
   - `ticket_state[E.ticket_id].state = VERIFYING`
   - `ticket_state[E.ticket_id].verification_phase = "quality"`
   - `qr_pool[<idle-qr-slot>].assignee = E.ticket_id`
   - Send:
     ```
     SendMessage({
       to: "<idle-qr-slot>",
       message: "Review <E.ticket_id> on branch fix/<E.ticket_id> (round <total_qr_rounds[E.ticket_id] + 1>).
     Diff against integration branch: git diff fix/batch-<stamp>...fix/<E.ticket_id>

     Findings parent: <findings_parent>. Out-of-scope findings and Lows must use
     \`--parent <findings_parent>\` when creating tickets.

     Run \`tk show <E.ticket_id>\` first and read prior-round notes — earlier QR verdicts, OOS tickets already filed, and implementer rework summaries. Do not re-pull concerns previous rounds ticketed as out-of-scope. On round ≥ 2, only flag findings that trace to a regression introduced by the most recent implementer change or a critical bug prior fixes could not address.

     Return one of:
       CLEAN — no blocking issues
       REWORK — numbered inline list of fixable findings
       FINDINGS — all blockers were out-of-scope; list the ticket IDs you created"
     })
     ```
   If two QR slots are idle and `quality_review_queue` has two or more
   entries, repeat this step for the second entry using the second idle slot.
4. **If both quality reviewers are busy** (`qr_pool` has no idle slot),
   leave the entry in `quality_review_queue`. The recycle handler in
   CLEAN/REWORK/FINDINGS will pop it naturally when a QR becomes available.
5. Output dashboard.

> The implementer slot S **remains assigned** to `ticket-id` throughout
> quality review. The slot is freed only after the ticket reaches CLOSED
> (handled by the merge + recycle protocol in the CLEAN handler below). If
> quality review returns REWORK, the implementer receives the rework
> assignment on the same slot S.

---

### CLEAN <ticket-id>

When a quality reviewer sends `CLEAN <ticket-id>`:

1. Verify `ticket_state[ticket-id].verification_phase == "quality"`.
1a. Increment `total_qr_rounds[ticket-id]` (for accurate round numbering on
    any subsequent dispatch — CLEAN normally ends the loop, but a later
    merge conflict can re-route through QR).
2. `ticket_state[ticket-id].state = MERGING`
3. `ticket_state[ticket-id].verification_phase = null`
4. Clear the QR slot: `qr_pool[<sending-qr-slot>].assignee = null`.
   Recycle the quality reviewer (shutdown_request → SHUTDOWN_ACK →
   re-spawn → WORKTREE OK; see [Recycle protocol](#recycle-protocol-reference)).
   When the recycled quality reviewer is ready: check
   `quality_review_queue`. If non-empty, pop the head and dispatch it
   (same as DONE step 3 — set `qr_pool[<slot>].assignee`, set
   `verification_phase = "quality"`, send the review message).
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
     If the check fires: set `merge_lock = null`, report the dirty status
     to the user, and halt all further merges until they resolve it.
   - Run:
     ```bash
     git -C $REPO_ROOT checkout fix/batch-<stamp>
     git -C $REPO_ROOT merge fix/<ticket-id> --no-ff -m "Fix <ticket-id>: <ticket title>"
     git -C $REPO_ROOT checkout main
     ```

   **On success (exit 0, no conflicts):**
   a. Set `ticket_state[ticket-id].state = MERGED`.
   b. Run `tk close <ticket-id>`.
   c. Set `ticket_state[ticket-id].state = CLOSED`;
      set `verification_phase = null`.
   d. Release merge lock: `merge_lock = null`.
   e. Run the [Worktree reset procedure](#worktree-reset-procedure) on
      slot S's worktree (`agent_pool[S].worktree`). If the reset
      verification fails (dirty status), mark slot S unavailable and
      report to the user — do not dispatch.
   f. Free the slot: `agent_pool[S].assignee = null`.
   g. If `merge_queue` is non-empty: pop the head entry `next-id`, set
      `merge_lock = next-id`, and run step 5 starting from the
      dirty-tree pre-flight for `next-id`.
   h. Call `dispatch_ready_tickets()`.

   **On conflict (non-zero exit or conflict markers):**
   a. Run `git -C $REPO_ROOT merge --abort`.
   b. Release merge lock: `merge_lock = null`.
   c. If `merge_queue` is non-empty: pop the head entry `next-id`, set
      `merge_lock = next-id`, and run step 5 for `next-id`.
   d. Set `ticket_state[ticket-id].state = REWORK`.
   e. Find slot S where `agent_pool[S].assignee == ticket-id`.
   f. If `agent_pool[S].assignments_since_spawn >= RECYCLE_CAP`: recycle
      slot S before sending (see [Recycle protocol](#recycle-protocol-reference)).
   g. Send the merge-conflict message to slot S:
      ```
      SendMessage({
        to: "<slot-S>",
        message: "Merge conflict when integrating <ticket-id> into fix/batch-<stamp>.
      The team lead has already run \`git merge --abort\` to clear the mid-merge state.

      In your worktree:
        git checkout fix/batch-<stamp>
        git merge fix/<ticket-id>
        # resolve all conflicts, then:
        git add <resolved-files>
        git commit

      Signal DONE when the resolution is committed. The re-merge after
      quality review will be a no-op by design."
      })
      ```
6. Output dashboard.

---

### REWORK <ticket-id> <findings>

When a quality reviewer sends `REWORK <ticket-id>` followed by a numbered
finding list:

1. Verify `ticket_state[ticket-id].verification_phase == "quality"`.
2. Increment `rework_count[ticket-id]` and `total_qr_rounds[ticket-id]`.
3. Recycle the quality reviewer (same procedure as CLEAN step 4). When
   ready, dispatch next from `quality_review_queue` if non-empty (same as
   CLEAN step 4).
3a. **Total-rounds cap.** If `total_qr_rounds[ticket-id] >= TOTAL_QR_ROUNDS_CAP`,
    escalate to the user with the drift framing (separate from the rework_count
    escalation in step 4):

   > `<ticket-id>` has been through quality review <total> times. This is past
   > the hard cap of 5 rounds. Possible causes:
   > 1. **Reviewer drift** — successive reviewers have moved the goalposts.
   >    Recommended action: merge the current branch and let me file remaining
   >    concerns as new tickets.
   > 2. **Implementer can't address findings** — fixes keep regressing or
   >    missing the point. Recommended action: reassign to a fresh implementer
   >    with explicit guidance.
   > 3. **Mark BLOCKED** and continue with other tickets.

   Run `tk show <ticket-id>` (or read the QR round notes) before deciding.
   Option 1 routes to CLEAN/MERGING immediately (skip steps 5–9); options 2
   and 3 follow the same handlers as the rework_count escalation below. Do
   NOT reset `total_qr_rounds[ticket-id]` on user guidance — the cap is
   durable across all rework loops for this ticket.

4. If `rework_count[ticket-id] >= 3`: escalate to the user. Do not
   dispatch rework until the user responds.

   > `<ticket-id>` has failed quality review 3 times. Options:
   > 1. **Provide guidance** — I will include your guidance in the rework message
   > 2. **Reassign** — pick a different implementer (resets all counters)
   > 3. **Mark BLOCKED** — skip this ticket and continue with others

   - **Option 1 (guidance):** Include the user's text in the rework
     message at step 8. Reset `rework_count[ticket-id] = 0` and continue
     to steps 5–9.
   - **Option 2 (reassign):** Reset `rework_count[ticket-id] = 0`. Free
     slot S (`agent_pool[S].assignee = null`). Select a different idle
     slot S'; if none is idle, wait for one to free up. Re-dispatch the
     ticket to S' as a standard rework assignment.
   - **Option 3 (BLOCKED):**
     - `tk set <ticket-id> --status blocked`
     - Run the [Worktree reset procedure](#worktree-reset-procedure) on
       slot S's worktree — **do not** delete the `fix/<id>` branch; leave
       it for post-run inspection.
     - `agent_pool[S].assignee = null`; slot S is now idle.
     - Identify downstream tickets (any with a direct or transitive
       dependency on `<ticket-id>`) and report them as stalled to the
       user.
     - Call `dispatch_ready_tickets()`.
     - Output dashboard with `<ticket-id>` in BLOCKED state.
       **Skip steps 5–9.**

5. `ticket_state[ticket-id].state = REWORK`
6. `ticket_state[ticket-id].verification_phase = null`
7. Find the implementer slot S where `agent_pool[S].assignee == ticket-id`.
8. If `agent_pool[S].assignments_since_spawn >= RECYCLE_CAP`: recycle
   slot S before sending (see [Recycle protocol](#recycle-protocol-reference)).
9. Forward the numbered findings verbatim:
   ```
   SendMessage({
     to: "<slot-S>",
     message: "Quality review returned REWORK for <ticket-id>. Fix these
   findings in your branch and signal DONE again:

   <numbered finding list verbatim from QR message>

   If any finding is genuinely out of scope (would require touching files
   this ticket never named), reply with:
     OUT_OF_SCOPE <n>: <one-sentence reason>
   I will convert those to tickets. Fix every finding you do not push
   back on."
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

When an implementer sends one or more `OUT_OF_SCOPE` lines in response to
a REWORK message:

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
       message: "Quality review REWORK — remaining findings after
     OUT_OF_SCOPE acknowledgement for <ticket-id>:

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

Call `dispatch_ready_tickets()` whenever a slot is freed (post-CLOSED)
and after the initial Phase 2 worktree-OK confirmation.

```
procedure dispatch_ready_tickets():
  # Re-query tk ready filtered to input ticket set
  run: tk ready
  filter: ticket_id is in the original input ticket set AND not yet
          in ticket_state (not DISPATCHED/in-flight/CLOSED/BLOCKED)

  for each idle implementer slot S (agent_pool[S].assignee == null):
    T = next ticket from fresh_ready
    if no such T exists: break

    ticket_state[T] = { state: DISPATCHED, verification_phase: null }
    rework_count[T] = 0
    total_qr_rounds[T] = 0
    agent_pool[S].assignee = T
    if assignments_since_spawn >= RECYCLE_CAP:
      # Recycle S before sending (see Recycle protocol section)
      # Recycle protocol step 6 resets assignments_since_spawn = 0
    agent_pool[S].assignments_since_spawn += 1
    # assignments_since_spawn = 1 after first dispatch to a recycled agent
    SendMessage({
      to: "<S>",
      message: "Ticket <T>: <T title>

Implement this ticket. Branch:
  git checkout fix/<T> 2>/dev/null || git checkout -b fix/<T> fix/batch-<stamp>

Run \`tk show <T>\` for full context. Signal DONE when committed."
    })

  output dashboard
```

This procedure re-queries `tk ready` on every call so that tickets whose
last blocker just closed appear immediately — no shadow DAG is maintained.

---

### Worktree reset procedure

Run this after every ticket CLOSED transition, before freeing the slot.
`<completed-id>` is the ticket just closed; `<worktree>` is
`agent_pool[S].worktree`.

```bash
# 1. Checkout the integration branch
git -C <worktree> checkout fix/batch-<stamp>

# 2. Hard-reset to HEAD of the integration branch
git -C <worktree> reset --hard fix/batch-<stamp>

# 3. Remove untracked files and directories
git -C <worktree> clean -fd

# 4. Remove the stale ticket branch from this worktree
git -C <worktree> branch -D fix/<completed-id> 2>/dev/null || true

# 5. Verify clean before the next ticket is dispatched
git -C <worktree> status --porcelain   # must produce empty output
```

If step 5 produces any output, the team lead does **not** dispatch the
next ticket to this slot. It marks the slot unavailable and reports the
dirty status to the user.

---

## Phase 4 — Completion

When all input tickets have reached CLOSED or BLOCKED state:

1. Report to the user:
   ```
   Fix-tickets-dag complete. N tickets closed, M tickets blocked.

   Closed tickets:
     [<id>] <title> — merged to fix/batch-<stamp>
     ...

   Blocked tickets (stalled, not merged):
     [<id>] <title>
     ...

   Integration branch: fix/batch-<stamp>

   Next steps:
     1. Review the full batch diff: git diff main fix/batch-<stamp>
     2. Deep review (optional):     /multi-review -- fix/batch-<stamp>
     3. Merge to main:              git checkout main && git merge fix/batch-<stamp> --no-ff
   ```

2. If non-blocking finding tickets remain open, list them:
   ```
   Non-blocking findings left open (tracked as tk tickets):
     <finding-ticket-ids>
   ```

3. Broadcast `shutdown_request` to all teammates:
   ```
   SendMessage({ to: "dag-impl-1", message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-impl-2", message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-impl-3", message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-impl-4", message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-qr-1",   message: { "type": "shutdown_request" } })
   SendMessage({ to: "dag-qr-2",   message: { "type": "shutdown_request" } })
   ```

4. Wait up to 30 seconds for `SHUTDOWN_ACK` from each teammate. Proceed
   after timeout — agents should already be idle.

5. Remove all worktrees:
   ```bash
   for N in 1 2 3 4; do
     git worktree remove .worktrees/fix-dag-$STAMP-impl-$N --force 2>/dev/null || true
   done
   git worktree remove .worktrees/fix-dag-$STAMP-qr-1 --force 2>/dev/null || true
   git worktree remove .worktrees/fix-dag-$STAMP-qr-2 --force 2>/dev/null || true
   ```

6. Call `TeamDelete()`.

---

## Edge Cases

### Pool livelock

Livelock condition: all implementer slots have `assignee != null` and
every assigned ticket is in REWORK state.

Detection: after any REWORK dispatch (REWORK handler step 11), if every
`agent_pool` slot is occupied and every assigned ticket is in REWORK state,
livelock is active.

Resolution:
1. Do **not** spawn extra implementers.
2. Log the livelock condition to the user, listing pinned tickets:
   > Pool livelock: all N implementer slots are pinned in rework.
   > Pinned: <ticket-ids>. Waiting for rework cycles to complete.
3. Continue waiting. As each rework cycle completes (implementer sends
   DONE), the slot frees and accepts the next item from `ready_queue`.
4. If no progress for >15 min, perform a heartbeat sweep: send a
   one-line status check via `SendMessage` to each busy implementer; call
   `TaskOutput` against each implementer's task to inspect recent tool
   output; report the findings in the dashboard under event header
   `heartbeat: livelock stall`. If any agent appears unresponsive,
   escalate to the user.

### Stuck agents

If any agent is marked busy and you have not received a message from
anyone in ~5 minutes, actively sweep: send a one-line status check via
`SendMessage` to each busy agent. If a specific agent has been busy on
the same task for ~15 minutes without a progress message, call
`TaskOutput` against its task to inspect what it is actually doing.
Report findings in the next dashboard update under event header
`heartbeat sweep`. If any agent appears truly unresponsive (no tool
output in 15 min), escalate to the user.

**STATUS is not DONE.** Implementers send STATUS mid-ticket. `SendMessage`
ends the sender's turn, so an implementer that sends STATUS and goes idle
has not finished — it is waiting for acknowledgement. If an implementer is
idle and its last message was STATUS, immediately send
`continue working on <ticket-id>`.

### Partial shutdown (user stops mid-run)

1. Broadcast `shutdown_request` to all teammates.
2. Wait up to 30 seconds for `SHUTDOWN_ACK` from each.
3. Call `TeamDelete()`.

In-progress tickets remain marked in-progress in `tk`. The user can
resume by running `/fix-tickets-dag` again with the same ticket IDs.

### Dirty working tree guard

The main repo's working tree must stay clean for the entire run. The
CLEAN handler pre-flight (`git status --porcelain` before each merge)
catches any corruption since the last successful merge. Do not try to
auto-recover. Stop further merges, report to the user with the offending
status output, and let the user triage.

---

## Recycle protocol (reference)

Before dispatching any work message to an implementer, check
`assignments_since_spawn`. If `>= RECYCLE_CAP (3)`, recycle first:

1. `SendMessage({ to: "<slot>", message: { type: "shutdown_request" } })`
2. Wait up to 30 s for `SHUTDOWN_ACK <slot>`.
3. Verify team lead CWD is still `REPO_ROOT`.
4. Re-spawn with the **exact same Agent call** used at startup: same
   `name`, same `subagent_type`, no `isolation: "worktree"` (worktree
   already exists).
   - **Implementer slots** (`dag-impl-1` .. `dag-impl-4`): read path from
     `agent_pool[slot].worktree`.
   - **QR slots** (`dag-qr-1`, `dag-qr-2`): derive from the stamp —
     `$REPO_ROOT/.worktrees/fix-dag-$STAMP-qr-<K>` (matching the paths
     created in Step 1.2).
5. Wait for `WORKTREE OK`. Wrong path or `WARNING` aborts the run.
6. Reset `assignments_since_spawn = 0`.

Quality reviewers recycle after **every** verdict (CLEAN, REWORK, or
FINDINGS). Same procedure: shutdown_request → SHUTDOWN_ACK → re-spawn
same Agent call → WORKTREE OK.

---

## Status dashboard format

Output a status dashboard every time agent or ticket state changes.

```
── <event description> ──────────────────────────────────

**Agents**

| Agent      | State        | Working on                | Last heard |
|---|---|---|---|
| dag-impl-1 | implementing | [cc-1abc] Fix null check  | 14:29:47   |
| dag-impl-2 | idle         |                           | 14:30:55   |
| dag-impl-3 | idle         |                           |            |
| dag-impl-4 | idle         |                           |            |
| dag-qr-1   | reviewing    | [cc-1abc]                 | 14:32:11   |
| dag-qr-2   | idle         |                           |            |

**Tickets**

| Ticket                    | State      | Notes            |
|---|---|---|
| [cc-1abc] Fix null check  | VERIFYING  | quality pass #1  |
| [cc-2def] Fix login       | DISPATCHED |                  |
| [cc-3ghi] Add logout      | BLOCKED    | waiting cc-2def  |

Progress: 0/3 closed

────────────────────────────────────────────────────────
```

Prefix all inbound teammate messages with the local clock time received
and update the "Last heard" cell for that agent.
