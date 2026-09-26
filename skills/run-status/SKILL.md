---
name: run-status
description: >
  Ticket-by-ticket status of a /run-tickets workflow run: what each ticket is doing
  now, its rework and conflict counts, findings filed, merges, and the integration
  check. Read-only. Use when the user asks how a /run-tickets run is going, what
  the agents are doing, or for a run status or progress update.
argument-hint: "[run-id]"
model: haiku
---

# Run Status

Report on a `/run-tickets` run. The snapshot comes from `run-tickets-status`,
which reads the run's own records: the run record `/run-tickets` writes into
`.worktrees/`, the workflow journal of agent starts and typed results, and the
final result once the run ends. Present what it says. Do not guess at state it
does not report, and do not message or inspect agents yourself.

## Steps

1. Run it from the repo the run belongs to:
   ```bash
   run-tickets-status [<run-id>]
   ```
   With no run ID it picks the newest run record in the current repo. Pass
   `$ARGUMENTS` through if the user named a run.

2. If it exits with "no /run-tickets run record", say there is no run to report
   in this repo. That also covers a finished run whose cleanup removed its
   record; its final report is in the conversation that launched it.

3. Present the output. Lead with one line: state (running or finished), how
   many tickets merged out of the total, and anything needing attention
   (`MERGES HALTED`, `BLOCKED`, a failing integration check). Then the ticket
   list as the script printed it.

4. Staleness: while running, compare "last agent activity" with the current
   time (`date`). If nothing has happened for more than 15 minutes, say so and
   suggest `/workflows` to see which agent is stuck (it can also stop or
   restart a single agent).

5. End with one line on what is likely next, derived only from the snapshot,
   for example "rf-12 is in review; rf-15 and rf-16 start when it merges."

For live detail on a single agent (its prompt and recent tool calls), point the
user to `/workflows`. This skill is the summary, not the live view.
