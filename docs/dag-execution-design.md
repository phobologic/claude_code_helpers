# DAG Execution Design

This document specifies the orchestration contract for the DAG-based team execution model.
Every load-bearing decision Phase 2 implementers depend on is pinned here. Where this
design diverges from the existing wave-based `skills/run-epic/SKILL.md`, the divergence is
called out explicitly.

---

## Data Model

### Ticket record (from `tk`)

The team lead reads ticket state from `tk` and never writes its own shadow copy of fields
that `tk` owns. The only team-lead-owned state is the in-memory structures below.

### In-memory team lead state

```
ticket_state: Map<ticket_id, TicketState>
  # one entry per non-closed child ticket of the epic

agent_pool: Map<slot_name, AgentSlot>
  # one entry per implementer slot (implementer-1 … implementer-4)
  slot_name: string
  assignee: ticket_id | null          # null = idle
  assignments_since_spawn: int        # recycle counter
  worktree: string                    # absolute path

pending_verifications: Queue<VerificationJob>
  ticket_id: string
  branch: string
  type: "ac" | "quality"

merge_lock: ticket_id | null          # ID of the ticket currently being merged, or null

wave_number: int                      # increments when a new set of tickets is dispatched
findings_parent: ticket_id            # parent epic for out-of-scope finding tickets

# Counters per ticket
ac_fail_count: Map<ticket_id, int>
rework_count: Map<ticket_id, int>
```

**Divergence from SKILL.md:** The current skill tracks `current_wave` (a set of in-flight
ticket IDs) for wave-based batch management. The new model replaces this with per-ticket
`TicketState` tracked individually, enabling continuous dispatching without wave gates.

---

## State Machine

Each ticket transitions through the following states. The team lead drives all transitions.

```
DISPATCHED
  → IMPL_DONE       trigger: implementer sends "DONE <ticket-id> <branch>"
                    action: enqueue AC verification job

IMPL_DONE
  → VERIFYING       trigger: AC verifier is idle and job is at head of queue
                    action: send ticket to AC verifier

VERIFYING
  → REWORK          trigger: AC verifier returns FAIL
                    action: increment ac_fail_count; write FAIL note to ticket;
                            send implementer the ticket ID for details;
                            if ac_fail_count >= 3: escalate to user
  → MERGING         trigger: QR returns CLEAN or FINDINGS
                    action: acquire merge_lock; begin fast-forward merge sequence
                            (see Merge Queue)
  → REWORK          trigger: QR returns REWORK
                    action: increment rework_count; forward inline findings to
                            implementer; if rework_count >= 3: escalate to user

  Note: VERIFYING covers both AC verification and quality review phases.
  The AC phase runs first; if it passes, quality review runs second.
  Both phases share this state label for simplicity.

REWORK
  → DISPATCHED      trigger: implementer signals DONE again (after fixing rework
                    findings or AC failures)
                    action: route to AC verification from the top

MERGING
  → MERGED          trigger: git merge completes without conflict
                    action: release merge_lock; close ticket in tk;
                            run DAG recomputation; dispatch newly unblocked tickets

  → REWORK          trigger: merge produces conflicts
                    action: release merge_lock; route to implementer for resolution;
                            after resolution, re-enter full validation cycle from
                            DISPATCHED

MERGED
  → CLOSED          trigger: tk close completes
                    action: update ticket_state; check for pool livelock;
                            dispatch next available ticket if a slot is free

CLOSED              terminal state for this run

BLOCKED             trigger: ac_fail_count >= 3 AND user says "mark blocked", OR
                             rework_count >= 3 AND user says "mark blocked"
                    action: see Rework & Pool Livelock section
```

**Divergence from SKILL.md:** The current skill has no named per-ticket states. AC fail
and rework thresholds exist (both 3) but tickets are not moved to a BLOCKED state — the
skill escalates to the user and stops. The new model adds BLOCKED as an explicit terminal
state so the run can continue with other tickets while the user decides.

---

## Message Protocol

All communication between the team lead and agents uses `SendMessage`. The exact formats
follow. The team lead parses the **first line** of every message to determine routing.

### Implementer → team lead

**Ticket done:**
```
DONE <ticket-id> ticket/<ticket-id>
```
Example: `DONE cc-1abc ticket/cc-1abc`

**Status update (mid-ticket, informational only):**
```
STATUS <slot-name>: <free text>
```
Example: `STATUS implementer-2: read cc-1abc, starting implementation`

**OUT_OF_SCOPE pushback (in response to REWORK):**
```
OUT_OF_SCOPE <finding-number>: <one-sentence reason>
```
Example: `OUT_OF_SCOPE 2: requires editing auth.py which this ticket never touched`
Multiple findings can appear as separate lines.

**SHUTDOWN_ACK:**
```
SHUTDOWN_ACK <slot-name>
```
Example: `SHUTDOWN_ACK implementer-3`

### Team lead → implementer (dispatch)

```
Ticket <ticket-id>: <ticket-title>

Implement this ticket. Branch: `git checkout ticket/<ticket-id> 2>/dev/null || git checkout -b ticket/<ticket-id> epic/<epic-id>`

Run `tk show <ticket-id>` for full context. Signal DONE when committed.
```

### Team lead → implementer (AC fail rework)

```
AC verification failed for <ticket-id>. Run `tk show <ticket-id>` — the verifier
wrote the specific failures as a note on the ticket. Fix, recommit, and signal DONE.
```

### Team lead → implementer (QR REWORK)

```
Quality review returned REWORK for <ticket-id>. Fix these findings in your branch
and signal DONE again:

<numbered finding list verbatim from QR message>

If any finding is genuinely out of scope (would require touching files this ticket
never named), reply with:
  OUT_OF_SCOPE <n>: <one-sentence reason>
I will convert those to tickets. Fix every finding you do not push back on.
```

### Team lead → implementer (stand-by after close)

```
<ticket-id> closed and merged. Stand by for next assignment.
```

### Team lead → AC verifier

```
Verify <ticket-id> on branch ticket/<ticket-id>. Run `tk show <ticket-id>` for
acceptance criteria. Write detailed results as a note on the ticket, then return
PASS or FAIL as the first word of your reply.
```

### AC verifier → team lead

**Pass:**
```
PASS <ticket-id>
<optional detail>
```

**Fail:**
```
FAIL <ticket-id>
<brief summary of which criteria failed — full detail goes in tk note>
```

### Team lead → quality reviewer

```
Review <ticket-id> on branch ticket/<ticket-id>. Changes passed AC verification.
Diff against integration branch: git diff epic/<epic-id>...ticket/<ticket-id>

Findings parent: <findings-parent-id>. Out-of-scope findings and Lows must use
`--parent <findings-parent-id>` when creating tickets.

Return one of:
  CLEAN — no blocking issues
  REWORK — numbered inline list of fixable findings
  FINDINGS — all blockers were out-of-scope; list the ticket IDs you created
```

### Quality reviewer → team lead

**Clean:**
```
CLEAN <ticket-id>
<optional notes on low/medium tickets created>
```

**Rework:**
```
REWORK <ticket-id>
1. <file:line> — <description> — <suggested fix>
2. <file:line> — <description> — <suggested fix>
...
```

**Findings (all out-of-scope):**
```
FINDINGS <ticket-id>
Ticketed: <finding-id-1>, <finding-id-2>
```

### Shutdown (team lead → any agent)

```json
{ "type": "shutdown_request" }
```

---

## Agent Lifecycle

### Implementers

- **Pool size:** `min(4, ready_ticket_count)` at startup. Never grows mid-run.
- **Recycling trigger:** Before dispatching any work message (initial ticket, AC-fail
  rework, QR rework), check `assignments_since_spawn`. If `>= RECYCLE_CAP` (default 3),
  recycle before dispatching.
- **Recycle procedure:**
  1. Send `shutdown_request` to the implementer. Wait up to 30 s for `SHUTDOWN_ACK`.
  2. Re-spawn with the **exact same Agent call** used at startup (same `name`, same
     worktree path, no `isolation: "worktree"`).
  3. Wait for `WORKTREE OK`. If wrong path or `WARNING`, abort the run.
  4. Reset `assignments_since_spawn = 0`.
- **Between tickets:** worktree is reset to a known-clean state before the next
  dispatch (see Worktree Lifecycle).

### AC verifiers

- **Pool size:** 1, shared across all in-flight tickets.
- **Recycling:** The AC verifier recycles after every verdict it produces — both PASS
  and FAIL, whether in an initial verification round or a rework round. The team lead
  sends `shutdown_request`, waits for `SHUTDOWN_ACK`, then re-spawns before the next
  verification job.
- **Serialization:** Only one AC verification runs at a time. Additional completed
  tickets queue in `pending_verifications`.

**Divergence from SKILL.md:** The current skill spawns a single AC verifier once and
never recycles it. The new model recycles after every verdict to prevent context
accumulation across many tickets.

### Quality reviewers

- **Pool size:** 1, shared across all in-flight tickets.
- **Recycling:** Same as AC verifier — recycles after every verdict (CLEAN, REWORK, or
  FINDINGS), both initial and rework rounds.
- **Serialization:** Only one quality review runs at a time. Tickets waiting for
  quality review queue behind any in-progress review.

**Divergence from SKILL.md:** The current skill spawns a single quality reviewer once
and never recycles it. The new model recycles after every verdict.

---

## Merge Queue

### Merge strategy

All merges use `--no-ff` (merge commit). Fast-forward and squash are not used.
This preserves the ticket branch topology in the integration branch history.

```bash
git checkout epic/<epic-id>
git merge ticket/<ticket-id> --no-ff -m "Merge <ticket-id>: <ticket title>"
git checkout main
```

### Lock acquisition

`merge_lock` is a single field in team lead state. Before beginning any merge:

1. Check `merge_lock`. If it is non-null, the merge cannot begin — add the ticket to
   the merge queue and wait.
2. Set `merge_lock = <ticket-id>`.
3. Perform the merge.
4. Set `merge_lock = null`.
5. Dequeue and start the next merge job if one is waiting.

### Concurrent merge requests

If a second ticket completes quality review while a merge is in progress:
- The second ticket's ID is appended to a `merge_queue` (ordered list).
- When the in-progress merge completes and `merge_lock` is released, the team lead
  takes the next entry from `merge_queue` and begins that merge.
- There is no parallelism in merging — exactly one merge runs at a time.

**Divergence from SKILL.md:** The current skill merges inline after each QR CLEAN
verdict with no locking. In a purely serial wave model this is safe. The new continuous
model can have multiple tickets completing validation in quick succession, making an
explicit merge lock necessary.

### "Fully merged" definition

A ticket is fully merged when:
1. `git merge` exits 0 with no conflicts.
2. `git checkout main` succeeds (team lead CWD restored).
3. `tk close <ticket-id>` completes.

Only after all three steps is the ticket considered merged for DAG recomputation
purposes. A merge that produces conflicts is not fully merged until the implementer
resolves them and the full validation cycle re-runs from DISPATCHED.

---

## Worktree Lifecycle

### Between-tickets reset protocol

After a ticket closes and before the same implementer slot is dispatched a new ticket,
the worktree is reset to a known-clean state:

```bash
# 1. Checkout the merge target (integration branch)
git checkout epic/<epic-id>

# 2. Hard-reset to HEAD of the integration branch
git reset --hard epic/<epic-id>

# 3. Remove untracked files and directories
git clean -fd

# 4. Remove the stale ticket branch from this worktree
git branch -D ticket/<completed-ticket-id> 2>/dev/null || true

# 5. Verify clean before the next ticket is dispatched
git status --porcelain   # must produce empty output
```

If step 5 produces any output, the team lead does **not** dispatch the next ticket.
It logs the dirty status, marks the slot unavailable, and reports to the user.

**Divergence from SKILL.md:** The current skill relies on wave boundary restarts to
implicitly reset agent context. Worktree state is never explicitly reset between tickets
within a wave. The new model adds an explicit reset protocol because implementers carry
over between tickets without a wave boundary.

### Stale branch removal

After reset, the team lead also removes the stale `ticket/<id>` branch from the
integration branch's remote-tracking reference (if any). Branch names in the worktree
are local only; no push is required for cleanup.

---

## DAG Recomputation

### Strategy

The team lead does **not** maintain an in-memory dependency graph. After each ticket
transitions to CLOSED, the team lead re-queries `tk ready` and filters results to
child tickets of the epic:

```bash
tk ready
# filter: .parent == "<epic-id>"
```

This is simpler than maintaining a shadow graph and stays consistent with any external
changes to ticket dependencies (e.g., a user adding a `tk dep` while the run is live).

### Detecting newly unblocked tickets

A ticket appears in `tk ready` output only when all its declared `deps` are closed.
Because the team lead re-queries after every CLOSED transition, any ticket whose last
blocker just closed will appear in the next `tk ready` call.

**Divergence from SKILL.md:** The current skill calls `tk ready` only at wave
boundaries (when `current_wave` empties). The new model calls it after every ticket
close, enabling immediate dispatch of unblocked work without waiting for an entire
batch to complete.

### Dispatch timing

Re-querying happens synchronously after `tk close` completes (step 3 of MERGING →
CLOSED). If new tickets are unblocked and a slot is free, dispatch proceeds immediately.
If no slots are free, the unblocked ticket IDs are held in a `ready_queue` and
dispatched as slots become free.

---

## Rework & Pool Livelock

### Maximum rework rounds

- **AC fail:** after 3 consecutive FAIL verdicts on the same ticket, the team lead
  does not dispatch another rework. It escalates to the user:
  > `<ticket-id>` has failed AC verification 3 times. Options: (1) review the AC and
  > provide guidance, (2) reassign to a different implementer, (3) mark BLOCKED and
  > continue with other tickets.

- **QR REWORK:** after 3 REWORK verdicts on the same ticket, same escalation prompt.

Counters reset to 0 on each new dispatch (i.e., a fresh ticket assignment clears both
`ac_fail_count` and `rework_count` for that ticket).

### BLOCKED ticket branch

When the user confirms a ticket should be BLOCKED:
- The `ticket/<id>` branch is **preserved** (not deleted). The user may want to inspect
  it or continue work manually.
- `tk set <ticket-id> --status blocked` marks the ticket.
- The implementing slot is freed: the worktree reset protocol runs, the slot is marked
  idle, and `assignments_since_spawn` is unchanged (the failed assignment counted).

### Worktree reset post-BLOCK

The worktree reset protocol (see Worktree Lifecycle) runs immediately after the slot
is freed. The stale `ticket/<id>` branch is **not** deleted from the worktree —
only the working tree is cleaned. The branch pointer remains for post-run inspection.

### Descendants of a BLOCKED ticket

When a ticket is marked BLOCKED:
- All tickets that have a direct or transitive dependency on the BLOCKED ticket are
  marked **stalled** (not BLOCKED). Stalled tickets are excluded from dispatch but
  retain their open status in `tk`.
- Stalled tickets will not appear in `tk ready` output because their dependency is
  not closed. No additional action is needed beyond blocking the parent.
- The team lead notes which tickets are stalled in the user escalation message so the
  user has a full picture of the blast radius.

**Divergence from SKILL.md:** The current skill escalates and stops without naming a
BLOCKED state or specifying descendant behavior. The new model makes BLOCKED explicit
and documents that descendants are automatically stalled by the dependency system
rather than requiring manual intervention.

### Pool livelock

Livelock condition: all implementer slots are assigned to tickets in REWORK (awaiting
further implementer action) and `ready_queue` is non-empty.

Detection: after any REWORK dispatch, if every slot's `assignee` is non-null and
every assigned ticket is in REWORK state, livelock is active.

Resolution:
1. The team lead does not spawn extra implementers.
2. The team lead reports the livelock condition to the user, listing the pinned
   tickets and the queued-but-undispatched tickets.
3. The team lead continues to wait. As each rework cycle completes (implementer sends
   DONE for a rework ticket), that slot is freed and can take the next item from
   `ready_queue`.
4. If all pinned tickets are stuck (no progress for >15 min), apply the heartbeat
   sweep and escalate per the normal stuck-agent procedure.

### AC-verifier queue discipline

When multiple tickets reach IMPL_DONE simultaneously, the AC verifier serves them
**FIFO** (first-in-queue, first-served). The `pending_verifications` queue is ordered
by the time the team lead received the DONE message from the implementer. No priority
reordering based on ticket priority is performed. This keeps the queue predictable and
avoids starvation of lower-priority tickets.

---

## Cold Start & Empty Ready Set

### Zero tickets ready at startup

If `tk ready` returns no tickets for this epic at startup, the team lead reports:

> No unblocked tickets found for epic `<epic-id>`. Check `tk blocked` to see what is
> holding things up. The run cannot proceed until at least one ticket is unblocked.

No team is created. The user must resolve blocking dependencies before retrying.

### Fewer than 4 tickets ready

If `tk ready` returns between 1 and 3 tickets:
- Only that many implementer slots are created: `pool_size = len(ready_tickets)`.
- The team lead notes: "Creating N implementer(s) — only N ticket(s) are ready now.
  Additional slots will not be added if more tickets unblock mid-run."
- Mid-run expansion (spawning extra implementers when new tickets unblock) is not
  supported. Newly unblocked tickets wait in `ready_queue` for a slot to free up.

**Divergence from SKILL.md:** The current skill counts ready tickets at the start of
each wave and spawns an appropriate number of implementers per wave. The new model
fixes the pool size at startup and does not resize mid-run.

---

## Children-before-parent Invariant

**Invariant:** No ticket may be dispatched until all tickets it depends on (direct and
transitive) have reached the CLOSED state, including any rework cycles those tickets
required.

A ticket in REWORK is not CLOSED. A ticket in MERGING is not CLOSED. A dependent
ticket will not appear in `tk ready` until all its declared `deps` are closed. The
team lead never bypasses `tk ready` to dispatch a ticket manually.

This invariant is enforced by the dependency system in `tk` and requires no additional
bookkeeping by the team lead.

---

## Failure & Shutdown

### Agent failure

If a spawned agent does not respond to `SendMessage` within 15 minutes (measured from
last heard time), the team lead:
1. Calls `TaskOutput` against the agent's task to inspect current output.
2. Reports findings in the dashboard under event header `heartbeat: stall detected`.
3. If the agent appears truly unresponsive (no recent tool output), escalates to user.

### Partial shutdown

If the user requests a stop mid-run:
1. Broadcast `shutdown_request` to all teammates.
2. Wait up to 30 seconds for `SHUTDOWN_ACK` from each.
3. Call `TeamDelete()`.
4. Tickets in-progress in `tk` remain in-progress — the user can resume by running
   the skill again. In-progress tickets are re-claimable on the next run.

### Worktree cleanup

Worktrees are removed only after all agents have acknowledged shutdown:
```bash
for N in 1 2 3 4; do
  git worktree remove .worktrees/implementer-$N-<STAMP> --force 2>/dev/null || true
done
git worktree remove .worktrees/ac-verifier-<STAMP>      --force 2>/dev/null || true
git worktree remove .worktrees/quality-reviewer-<STAMP> --force 2>/dev/null || true
```

---

## Risks

### AC-verifier bottleneck

**Risk:** A single AC verifier running serially becomes a throughput ceiling when
multiple tickets complete in parallel. With 4 implementers in flight, the AC verifier
can queue 3 tickets while serving 1, adding latency to each ticket's cycle time.

**Assessment:** Acceptable for typical epics (4–12 tickets). The serial cost per
verification is low (read ticket, read diff, check ACs) relative to implementation
time. A pool of 2–3 verifiers would require load-balancing logic that adds more
complexity than the latency savings justify at this scale.

**Deferral:** If epics routinely exceed 10 simultaneously-completing tickets, revisit
with a verifier pool. No action in this phase.

### Per-ticket spawn cost

**Risk:** Recycling both the AC verifier and quality reviewer after every verdict
adds spawn latency per ticket (one spawn cycle for each of the two review stages).
For a 10-ticket epic, that is up to 20 extra agent spawns.

**Assessment:** Spawn cost is measured in seconds; implementation time is measured in
minutes. The tradeoff (fresh context, no cross-ticket contamination) is worth it.
The current skill's single-spawn approach has caused context compaction mid-run on
large epics, which is harder to diagnose and recover from.

**Resolution:** Accept the spawn cost. No deferral needed.

### Worktree-lifecycle / merge-lock interaction

**Risk:** If the merge-lock holder's merge is slow (e.g., large diff, many conflicts
routed back for implementer resolution), other tickets pile up in the merge queue.
Meanwhile, their implementer slots sit idle after signaling DONE, and the worktree
reset cannot proceed until the slot is dispatched the next ticket. This is not a
deadlock (the merge eventually finishes) but it can idle slots for longer than
expected.

**Assessment:** The worktree reset runs when the *slot* is freed (after the current
ticket closes), not when the merge lock is acquired. Slots are freed after CLOSED,
which requires a successful merge. Therefore a slot waiting in the merge queue holds
its implementer until the merge completes — the slot is not idle, it is waiting for
a system resource. This is expected behavior, not a bug.

**Deferral:** If merge serialization becomes a bottleneck in practice, an
octopus-merge strategy or parallelized merge into separate staging branches could be
explored. Deferred to a future phase.
