---
name: team-status
description: Report a consistent status snapshot for an in-flight /run-epic, /fix-tickets, or DAG variant — the epic/batch progress, every ticket and its state, every agent and what it's doing, and any interesting events from the run so far. Use when the user asks "what's the status", "how's the run going", "what are the agents doing", or similar during an active agent-team execution.
argument-hint: "[epic-id]"
model: sonnet
---

# Team Status

Produce a single, consistently-shaped status report for the currently-running
agent team (`/run-epic`, `/run-epic-dag`, `/fix-tickets`, or `/fix-tickets-dag`).

The output of this skill should look the same every time it's invoked, so the
user can scan it at a glance across runs. Do not editorialize or restructure
the report; fill in the template below.

## Phase 1 — Identify the run

Determine which run to report on:

1. If `$ARGUMENTS` contains an epic ID, use it.
2. Otherwise, look at the active team in this conversation:
   - The team lead skill (e.g. `/run-epic-dag`) holds the epic ID and ticket
     state in conversation context. Pull it from there.
   - If multiple runs are active, list them and ask the user which one.
3. If no run is active and no argument was given, fall back to the most
   recently-touched epic: `tk query '.type == "epic" and .status == "in-progress"'`
   sorted by `updated_at` desc. If exactly one matches, use it; otherwise list
   candidates and ask.

Record:
- `EPIC_ID` — the epic or batch ID
- `BRANCH` — integration branch (`epic/<id>` or `fix/batch-*`) if one exists
- `RUN` — the run label: the stamp shared by this run's agent names and
  worktree paths (e.g. `epic-dag-20260906-143022`), if one is in flight

## Phase 2 — Gather data

Run these in parallel:

- `tk show <EPIC_ID>` — epic title and metadata
- `tk query '.parent == "<EPIC_ID>"'` — every child ticket with status, assignee, notes
- `ListAgents` — every agent this session has spawned; the rows whose names
  carry this run's stamp are its pool, and each row says whether that agent is
  busy or idle right now
- `git -C <repo-root> worktree list` — active worktrees for this run
- `git -C <repo-root> log main..<BRANCH> --oneline` — commits landed so far (if branch exists)

For "interesting events," scan:
- Notes on each child ticket (`tk show-multi`) for the most recent 1-2 notes
- Any tickets whose status flipped to `blocked` or whose parent is `FINDINGS_PARENT`
  (out-of-scope findings created mid-run)
- Quality-review rework loops (tickets with multiple in-progress→review cycles
  visible in their notes)
- Failed AC verifications still pending rework
- Agents in the pool that are idle while tickets remain unblocked

## Phase 3 — Render the report

Output exactly this shape, as your text response (not in a tool call). Use a
fenced code block only for the ticket table; everything else is plain markdown.

```
## Team Status — <EPIC_ID> <epic title>
Branch: <BRANCH or "none">   Run: <RUN or "none">

### Progress
<X>/<Y> tickets closed · <N> in-progress · <M> blocked · <K> open
Commits on branch: <count>

### Tickets
| ID | Status | Assignee | Title |
|----|--------|----------|-------|
| ... one row per child ticket, sorted: in-progress first, then blocked, open, closed ... |

### Agents
- <slot-name> — <state> — <ticket-id or "idle"> — <last activity, e.g. "implementing", "awaiting review", "rework cycle 2">
- ... one line per agent in the pool ...

Source the roster from `ListAgents`, filtered to rows whose names carry this
run's stamp; take the busy/idle state from those rows. Cross-check against the
lead's in-conversation `agent_pool`/`qr_pool` for the assigned ticket. An agent
the lead believes is working but that `ListAgents` does not list has died —
call that out under Notable events.

### Notable events
- <bullet per interesting thing — out-of-scope finding filed, rework loop, blocker, idle agent, AC failure pending, etc.>
- If nothing notable: "Nothing unusual — run is proceeding cleanly."

### Next expected transition
<one sentence: what's likely to happen next — e.g. "dag-impl-2 finishing ticket abc-7 should unblock abc-9 and abc-10">
```

## Rules

- **Never modify ticket state from this skill.** Read-only.
- **Never spawn agents or send messages to the team** — this is a status report,
  not a coordination action.
- If the active team has in-conversation state (ticket_state map, agent_pool),
  prefer that over re-deriving from `tk` — it's more current.
- Keep the report tight. One screen. If the ticket list is huge (>30), collapse
  closed tickets into a count and only table the rest.
- Always run the data-gathering commands fresh — do not reuse stale output from
  earlier in the conversation.
