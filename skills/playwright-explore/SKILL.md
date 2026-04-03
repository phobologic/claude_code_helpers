---
name: playwright-explore
description: >
  Spawn a team of Playwright-driven agents to explore a running web app as
  simulated users. A GM agent sets up a game/session and shares state with
  player agents via messaging; all agents report findings back to the team
  lead, who deduplicates and creates tk tickets. Use when the user says
  "explore the app", "test the app with playwright", "simulate users", or
  similar.
argument-hint: "<url> [-- <scenario description>]"
---

# Playwright Explore

You are the **team lead**. You orchestrate a live exploratory test of a running
web app using a team of simulated users. You never use the browser yourself —
your job is to spawn agents, relay coordination messages, receive findings, and
create tk tickets from what the testers discover.

## Phase 0 — Parse arguments and confirm

Parse `$ARGUMENTS`:
- First token is the app URL (required). If missing, ask the user.
- Everything after `--` is a free-form scenario description. Use it to
  customize what the agents explore. Default scenario: "Set up a game as the
  GM, have players join and interact, and explore the app as real users would."

Identify the roles from the scenario. By default use three agents:
- `gm-tester`: logs in as the Game Master / host / organizer
- `player-1`: logs in as the first player / participant
- `player-2`: logs in as the second player / participant

If the scenario implies different roles (e.g., admin + customer, or just two
players with no GM), adjust accordingly and explain the roster to the user.

Present a short plan and wait for confirmation:

```
App:      <url>
Scenario: <scenario>
Agents:   gm-tester (sonnet), player-1 (sonnet), player-2 (sonnet)
Epic:     will be created now

Proceed? [y/N]
```

## Phase 1 — Create the epic

```bash
EPIC_ID=$(tk create "Playwright explore: <url> (<YYYY-MM-DD HH:MM>)" \
  -t epic -p 2 \
  --tags "playwright,exploratory-testing" \
  -d "Live exploratory test of <url>. Agents simulate <roles> and report UX issues, broken flows, and missing features.")
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

Note the `team_name` — pass it to every Agent call so teammates can message
each other and the team lead.

## Phase 3 — Spawn the testers

Spawn all three testers in parallel. Each is a general-purpose agent using
**sonnet** model. Give each a focused brief — they don't need to know about
the ticket system.

### GM tester

```
Agent({
  prompt: "
You are gm-tester, a QA agent simulating a Game Master in a live web app at <url>.

## Your job
Explore the app as a GM/host would. Use playwright-cli to control a browser. Log in or create an account as a GM-type user (use realistic test
credentials like gm@test.com / password123, or register if needed).

## Scenario
<scenario>

## Coordination protocol
You will need to cooperate with player agents. When you have information they
need to proceed (invite links, game IDs, join codes, URLs), send it to them:
  SendMessage({ to: 'player-1', content: '<the info>' })
  SendMessage({ to: 'player-2', content: '<the info>' })
Wait for players to confirm they've joined before continuing if the scenario
requires it. Players will message you when they've completed a coordination step.

## Reporting findings
Whenever you notice something broken, confusing, missing, or worth improving,
send a structured finding to the team lead:
  SendMessage({
    to: 'team-lead',
    content: JSON.stringify({
      title: '<short title>',
      description: '<what happened, what you expected, steps to reproduce>',
      severity: 'critical | high | medium | low',
      confidence: 0.0-1.0,  // how sure are you this is a real issue vs. user error?
      tags: ['<tag>', ...]
    })
  })

Send findings as you discover them — don't batch them at the end.
When you are done exploring, send: SendMessage({ to: 'team-lead', content: 'DONE' })
  ",
  subagent_type: "general-purpose",
  model: "sonnet",
  team_name: "<team_name>",
  name: "gm-tester",
  run_in_background: true
})
```

### Player testers

Spawn player-1 and player-2 in parallel. The prompt is the same structure;
customize the role name and coordination direction (players wait for GM, then
confirm back).

```
Agent({
  prompt: "
You are player-1, a QA agent simulating a Player in a live web app at <url>.

## Your job
Explore the app as a regular player/participant would. Use playwright-cli to
control a browser. Log in or create an account as a
player-type user (e.g. player1@test.com / password123, or register if needed).

## Scenario
<scenario>

## Coordination protocol
Wait for the GM to send you the information you need to join (invite link, game
ID, etc.). You will receive a message from gm-tester — use that info to
join the session. Once you've joined, confirm back:
  SendMessage({ to: 'gm-tester', content: 'player-1 joined' })
Then continue exploring as a player would.

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

Send findings as you discover them.
When you are done exploring, send: SendMessage({ to: 'team-lead', content: 'DONE' })
  ",
  subagent_type: "general-purpose",
  model: "sonnet",
  team_name: "<team_name>",
  name: "player-1",
  run_in_background: true
})
```

Spawn player-2 identically with name `player-2` and credentials
`player2@test.com`.

## Phase 4 — Coordination loop

This is your main loop. You receive messages from testers and act on them.

### When you receive a finding (JSON payload from any tester):

Parse the finding. Before creating a ticket, check whether it duplicates an
existing one:

```bash
tk query  # scan open tickets in the epic for similar titles/descriptions
```

**If it's a new issue**, create a ticket:

```bash
tk create "<title>" \
  -t bug \
  -p <priority>  \  # 0=critical, 1=high, 2=medium, 3=low, 4=backlog
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

**If it duplicates an existing ticket**, add the new context as a note instead:

```bash
tk add-note <existing-id> "Additional report from <agent>: <description>"
```

Acknowledge the finding back to the tester so they know it was received
(one-line SendMessage is fine; keeps their context clean).

### When you receive `DONE` from an agent:

Note that the agent has finished. When all agents have sent `DONE`, proceed to
Phase 5.

### While waiting:

Periodically check in with agents that haven't sent a finding or status in a
while. If an agent appears stuck, ask for a status update.

## Phase 5 — Completion

When all agents have sent `DONE`:

1. Summarize the epic:

```bash
tk query '.parent == "<epic-id>"'
```

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

3. Shut down the team:

```
SendMessage({ to: 'gm-tester',  content: 'Session complete. Shutting down.' })
SendMessage({ to: 'player-1',   content: 'Session complete. Shutting down.' })
SendMessage({ to: 'player-2',   content: 'Session complete. Shutting down.' })
TeamDelete()
```

## Edge Cases

**Agent can't connect to the app.** If a tester reports that `<url>` is
unreachable, stop immediately and tell the user the app doesn't appear to be
running.

**Coordination stall.** If players are waiting for the GM and the GM hasn't
sent an invite after several minutes, message the GM directly:
```
SendMessage({ to: 'gm-tester', content: 'Players are waiting for the invite link — have you created the game yet?' })
```

**playwright-cli not available.** If a tester reports that `playwright-cli` isn't
found, suggest the user install it and retry.

**Duplicate flood.** If multiple agents report the same issue within a short
window, create one ticket and note all reporters:
```bash
tk add-note <id> "Also observed by <agent>: <their description>"
```
