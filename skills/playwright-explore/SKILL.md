---
name: playwright-explore
description: >
  Spawn a team of Playwright-driven agents to explore a running web app as
  simulated users. Roles are configurable; all agents report findings back to
  the team lead, who deduplicates and creates tk tickets. Use when the user
  says "explore the app", "test the app with playwright", "simulate users", or
  similar.
argument-hint: "<url> [roles:role1,role2,role3] [time:30m] [-- <scenario description>]"
---

# Playwright Explore

You are the **team lead**. You orchestrate a live exploratory test of a running
web app using a team of simulated users. You never use the browser yourself —
your job is to spawn agents, relay coordination messages, receive findings, and
create tk tickets from what the testers discover.

This skill uses `playwright-cli` (disk-backed, ~4x more token-efficient than
Playwright MCP). If `playwright-mcp` is connected in the current session, its
tool schemas cost tokens on every turn even when unused — ask the user to
disconnect it with `/mcp` before confirming the plan.

## Phase 0 — Parse arguments and confirm

Parse `$ARGUMENTS` in this order:

1. **URL** — first token (required). If missing, ask the user.
2. **Roles** — look for a `roles:` token (e.g. `roles:gm,player1,player2`).
   Split on commas to get the role list.
   - If `roles:` is absent, default to: `participant-1,participant-2,participant-3`
   - The **first role** is always the session initiator — it sets up the
     session and shares any join links or state with the other roles.
   - Remaining roles are joiners — they wait for the initiator's signal,
     then proceed.
3. **Time limit** — look for a `time:` token (e.g. `time:30m`, `time:2h`, `time:1h30m`).
   Parse to seconds (`30m` → 1800, `2h` → 7200, `1h30m` → 5400). If absent, no limit.
4. **Scenario** — everything after `--` is a free-form description of what to
   explore. Default: "Explore the app as real users would, exercising the core
   flows end-to-end."

Derive agent names from the roles (e.g. role `gm` → agent name `gm`,
role `participant-1` → agent name `participant-1`).

Present a short plan to the user:

```
App:        <url>
Roles:      <role-1> (initiator), <role-2>, <role-3>  [sonnet each]
Scenario:   <scenario>
Time limit: <N minutes/hours — session ends at ~HH:MM> / none
Epic:       will be created now
```

Then ask for confirmation via `AskUserQuestion`:

```
AskUserQuestion({
  questions: [{
    question: "Start the exploratory session with this plan?",
    header: "Explore",
    multiSelect: false,
    options: [
      { label: "Proceed (Recommended)",
        description: "Create the epic, spawn tester agents, begin exploration" },
      { label: "Cancel",
        description: "Stop now — no epic or agents are created" }
    ]
  }]
})
```

The user can also pick "Other" to adjust the roles, scenario, or time
limit before you proceed. Wait for their answer before doing anything.

If a time limit was given, compute the deadline immediately after confirmation:

```bash
DEADLINE_TS=$(( $(date +%s) + DURATION_SECONDS ))
# human-readable: macOS uses -r, Linux uses -d @
DEADLINE_HUMAN=$(date -r $DEADLINE_TS "+%H:%M" 2>/dev/null || date -d "@$DEADLINE_TS" "+%H:%M")
```

Record `DEADLINE_TS` and `DEADLINE_HUMAN` — pass both into every agent prompt.
If no time limit, set `DEADLINE_TS=0` and omit the **Time limit** section from prompts.

## Phase 1 — Create the epic

```bash
EPIC_ID=$(tk create "Playwright explore: <url> (<YYYY-MM-DD HH:MM>)" \
  -t epic -p 2 \
  --tags "playwright,exploratory-testing" \
  -d "Live exploratory test of <url>. Roles: <role list>. Scenario: <scenario>")
echo $EPIC_ID
```

Note `EPIC_ID` for all ticket creation in Phase 4.

## Phase 2 — Create the team

```
TeamCreate({
  team_name: "playwright-<timestamp>",
  description: "Exploratory test team for <url>"
})
```

Note the `team_name` — pass it to every Agent call.

## Phase 3 — Spawn the testers

Each agent prompt is assembled from two parts:

1. The **shared agent prompt** below (identical for every role, with `<role>`
   and `<url>` substituted).
2. A small **role delta** — initiator vs. joiner — inserted under the
   `## Scenario` section.

Spawn all roles in parallel (single message, multiple `Agent` tool calls).
Each uses **sonnet**. After assembly, call:

```
Agent({
  prompt: "<assembled prompt>",
  subagent_type: "general-purpose",
  model: "sonnet",
  team_name: "<team_name>",
  name: "<role>",
  run_in_background: true
})
```

### Shared agent prompt

```
You are <role>, a QA agent exploring a live web app at <url>.

## Your job
Use playwright-cli to control a browser. Log in or create an account using
realistic test credentials (e.g. <role>@test.com / password123, or register
if needed).

## Playwright CLI usage

Always pass `-s=<role>` on every playwright-cli command. Without it, all
agents share the same browser session and clobber each other's logins.

  playwright-cli -s=<role> open <url>
  playwright-cli -s=<role> snapshot [--filename <path>]
  playwright-cli -s=<role> click <ref>
  playwright-cli -s=<role> fill <ref> <value>
  playwright-cli -s=<role> goto <url>
  playwright-cli -s=<role> state-save <path>    # persist auth after login
  playwright-cli -s=<role> state-load <path>    # restore auth on re-run

Run `playwright-cli --help` and `playwright-cli <command> --help` if you need
to check flags — don't invent options.

## Snapshot discipline (critical — this is where token budgets die)

`playwright-cli snapshot` returns the full accessibility tree with element
refs like `e21`, `e35` directly in the response. There is no depth flag and
no way to scope to a subtree — every snapshot is the whole page.

Rules:
- **Re-snapshot only after state-changing actions** (click, submit, goto).
  Refs from the prior snapshot remain valid until something changes — don't
  snapshot "just to check."
- **Reuse refs from your last snapshot** instead of re-snapshotting to look
  them up again.
- **Use `--filename <path>` to redirect big snapshots to a file** when you
  only need to confirm an action succeeded and don't want the tree in
  context. Don't `Read` the file afterward — that defeats the point.

## Screenshots

Don't take screenshots unless you're verifying a visual bug. When you must:
- They land in `.playwright-cli/` as PNG files.
- **Never `Read` a screenshot** — you don't need to see pixels to file a bug.
  Cite the file path in your finding and move on.

## Auth persistence

After a successful login, save state so re-runs can skip the login flow:
  playwright-cli -s=<role> state-save .playwright-cli/<role>-auth.json

At startup, if that file already exists, load it before visiting the app:
  playwright-cli -s=<role> state-load .playwright-cli/<role>-auth.json

## Scenario

<scenario>

<ROLE DELTA — see below>

## Staying reachable (critical)

The team lead must be able to redirect you at any time. Two hard rules:

1. **Check your inbox before every `playwright-cli` command.** If there is a
   message from `team-lead`, read it and act on it *before* running the next
   playwright action. Never run more than one playwright-cli command without
   first checking for new messages.
2. **Heartbeat at least once per minute.** If ~60 seconds have passed since
   your last message to the team lead, send a STATUS update before your
   next action, even if nothing notable has happened:
     SendMessage({ to: 'team-lead', content: 'STATUS <role>: <what you are doing now>' })

Also send a STATUS after each milestone (logged in, joined/set up session,
completed a major flow) — but the two rules above are the floor, not the
milestones. Going silent for minutes is a bug, not focus.

## Time limit
Deadline: <DEADLINE_TS> (unix epoch) — approximately <DEADLINE_HUMAN>

At every heartbeat, check the current time before continuing:
  date +%s

- **Within 120 seconds of deadline**: finish your current action, then wrap
  up — do not start any new major flow.
- **At or past the deadline**: flush everything and send DONE (see below).

**Wrapping up when time is up:**
1. Send any observations you haven't reported yet.
2. For anything you suspected but didn't have time to verify, send a theory
   finding:
   SendMessage({
     to: 'team-lead',
     content: JSON.stringify({
       title: '<short title>',
       description: 'Theory — not yet verified: <what you suspect, why, and how you would verify it>',
       severity: '<your best estimate>',
       confidence: 0.1-0.3,
       tags: ['theory', 'unexplored', ...]
     })
   })
3. Send DONE.

## Shutdown
If you receive a shutdown or TIME_UP message from the team lead, finish your
current action, flush any unsent findings and theories (using the format
above), then send DONE immediately. Do not continue to the next step.

## Reporting findings
Whenever you notice something broken, confusing, missing, or worth improving,
send a structured finding to the team lead:
  SendMessage({
    to: 'team-lead',
    content: JSON.stringify({
      title: '<short title>',
      description: '<what happened, what you expected, steps to reproduce>',
      severity: 'critical | high | medium | low',
      confidence: 0.0-1.0,
      tags: ['<tag>', ...]
    })
  })

Keep `description` tight: expected vs. actual plus repro steps. The team lead
expands it into the ticket — don't write paragraphs.

Send findings as you discover them — don't batch at the end.
When done: SendMessage({ to: 'team-lead', content: 'DONE' })
```

### Role delta — initiator (first role only)

Insert under `## Scenario` in the shared prompt when assembling the initiator:

```
## Coordination protocol (initiator)
You go first. Once you have set up the session and have information the
other agents need to join or participate (invite links, join codes, session
IDs, URLs, etc.), send it to each of them:
  SendMessage({ to: '<role-2>', content: '<the info>' })
  SendMessage({ to: '<role-3>', content: '<the info>' })
Wait for them to confirm before continuing steps that require their presence.
They will message you when they've completed a coordination step.
```

### Role delta — joiner (remaining roles)

Insert under `## Scenario` in the shared prompt when assembling each joiner:

```
## Coordination protocol (joiner)
Wait for <role-1> to send you the information you need to join the session
(invite link, join code, session ID, etc.). Once you have it, use it to join,
then confirm back:
  SendMessage({ to: '<role-1>', content: '<role> joined' })
Then continue exploring from your role's perspective.
```

## Phase 4 — Coordination loop

This is your main loop. You receive messages from testers and act on them.

**Maintain a local dedup index.** As you create tickets in this session, keep
a running in-context list of `{id, title}` for every ticket you've created
under this epic. Compare incoming findings against this local list — do not
re-query `tk` for every finding. The local list is always authoritative for
this session because you are the only creator.

### When you receive a finding (JSON payload from any tester):

Parse the finding. Compare its `title` (case-insensitive, fuzzy) against your
local dedup index.

**If it's a new issue**, create a ticket and append `{id, title}` to the index:

```bash
tk create "<title>" \
  -t bug \
  -p <priority> \  # 0=critical, 1=high, 2=medium, 3=low, 4=backlog
  --parent $EPIC_ID \
  --tags "<tags from finding, plus 'playwright'>" \
  -d "<description>

Confidence: <confidence score> (<rationale>)

Reported by: <agent-name>

## Acceptance Criteria (EARS format)
- When <trigger>, the system shall <behavior>.
- While <state>, the system shall <behavior>.
- The system shall <behavior>.
[Write 2-4 ACs that would verify the issue is fixed]"
```

**If it duplicates an existing ticket** in the local index, add the new
context as a note instead:

```bash
tk add-note <existing-id> "Additional report from <agent>: <description>"
```

Acknowledge the finding back to the tester (one-line SendMessage is fine).

### When you receive `DONE` from an agent:

Note it. When all agents have sent `DONE`, proceed to Phase 5.

### Timestamping inbound messages

Every time you quote or summarize an agent's message to the user, prefix it
with the local clock time you received it, e.g.
`[14:32:05] player-1: STATUS — joined session, viewing game list`. Track
each agent's most recent message time ("last heard") so you can spot stalls.

### Heartbeat cadence (active monitoring)

Agents are required to STATUS at least once per minute. If they stop, act:

- **~2 minutes of silence from any agent**: send a one-line ping —
  `SendMessage({ to: '<role>', content: 'ping — still alive? what are you doing?' })`.
- **~5 minutes with no progress** on the same action: use `TaskOutput`
  against that agent's task to inspect what it's actually doing. Hook
  failures, stuck playwright commands, and orphaned confirmation prompts
  show up there.
- Report sweep results to the user, prefixed with the clock time.

Don't passively wait — if you haven't heard from anyone in a while and the
session isn't done, assume something is stuck and investigate.

### Time enforcement:

If a `time:` limit was specified, check the deadline after processing each
incoming message:

```bash
date +%s
```

If `now >= DEADLINE_TS` and any agents haven't sent `DONE` yet, send TIME_UP
to each still-active agent:

```
SendMessage({ to: '<role-N>', content: 'TIME_UP — time limit reached. Flush your outstanding findings and any unexplored theories, then send DONE.' })
```

Give agents up to 2 minutes to complete their flush. After that, proceed to
Phase 5 with whoever has reported in — don't wait indefinitely.

## Phase 5 — Completion

1. Summarize the epic from your local dedup index (no need to re-query tk —
   you already have `{id, title}` for every ticket you created).

2. Report to the user:

```
Exploratory session complete.

Epic: <epic-id>
Tickets created: N
  [<id>] <title> (priority: <p>, confidence: <c>)
  ...

Suggested next steps:
  tk ready                          # see what's unblocked
  /run-epic <epic-id>               # implement fixes
  tk show <id>                      # review individual tickets
```

3. Shut down the team (send to each role by name, then delete):

```
SendMessage({ to: '<role-1>', content: 'Session complete. Shutting down.' })
SendMessage({ to: '<role-2>', content: 'Session complete. Shutting down.' })
...
TeamDelete()
```

## Edge Cases

**Agent can't connect to the app.** Stop immediately and tell the user the
app doesn't appear to be running at `<url>`.

**Coordination stall.** If joiners are waiting and the initiator hasn't sent
anything, prompt it directly:
```
SendMessage({ to: '<role-1>', content: 'Other agents are waiting — have you set up the session yet?' })
```

**playwright-cli not available.** If a tester reports `playwright-cli` isn't
found, suggest the user install it and retry. Point them at
`playwright-cli install --skills` which registers it as a Skill so its command
schemas aren't loaded into the model context at startup.

**Duplicate flood.** If multiple agents report the same issue, create one
ticket and note all reporters:
```bash
tk add-note <id> "Also observed by <agent>: <their description>"
```
