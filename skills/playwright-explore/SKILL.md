---
name: playwright-explore
description: >
  Spawn a team of Playwright-driven agents to explore a running web app as
  simulated users. Roles are configurable; all agents report findings back to
  the team lead, who deduplicates and creates tk tickets. Use when the user
  says "explore the app", "test the app with playwright", "simulate users", or
  similar.
argument-hint: "<url> [roles:role1,role2,role3] [-- <scenario description>]"
---

# Playwright Explore

You are the **team lead**. You orchestrate a live exploratory test of a running
web app using a team of simulated users. You never use the browser yourself —
your job is to spawn agents, relay coordination messages, receive findings, and
create tk tickets from what the testers discover.

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
3. **Scenario** — everything after `--` is a free-form description of what to
   explore. Default: "Explore the app as real users would, exercising the core
   flows end-to-end."

Derive agent names from the roles (e.g. role `gm` → agent name `gm`,
role `participant-1` → agent name `participant-1`).

Present a short plan and wait for confirmation:

```
App:      <url>
Roles:    <role-1> (initiator), <role-2>, <role-3>  [sonnet each]
Scenario: <scenario>
Epic:     will be created now

Proceed? [y/N]
```

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

Spawn all agents in parallel. Each uses **sonnet** model. Construct each
agent's prompt from the role name, the role's position (initiator vs. joiner),
and the scenario.

### Initiator agent (first role)

```
Agent({
  prompt: "
You are <role-1>, a QA agent exploring a live web app at <url>.

## Your job
You are the session initiator. Use playwright-cli to control a browser.
Log in or create an account using realistic test credentials for your role
(e.g. <role-1>@test.com / password123, or register if needed).

## Playwright CLI usage
Always pass `-s=<role-1>` on every playwright-cli command. Without it, all
agents share the same browser session and will clobber each other's logins.

  playwright-cli -s=<role-1> open <url>
  playwright-cli -s=<role-1> snapshot
  playwright-cli -s=<role-1> click <ref>
  playwright-cli -s=<role-1> fill <ref> <value>
  playwright-cli -s=<role-1> goto <url>

## Scenario

<scenario>

## Coordination protocol
You go first. Once you have set up the session and have information the other
agents need to join or participate (invite links, join codes, session IDs,
URLs, etc.), send it to each of them:
  SendMessage({ to: '<role-2>', content: '<the info>' })
  SendMessage({ to: '<role-3>', content: '<the info>' })
Wait for them to confirm before continuing steps that require their presence.
They will message you when they've completed a coordination step.

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

Send findings as you discover them — don't batch at the end.
When done, send: SendMessage({ to: 'team-lead', content: 'DONE' })
  ",
  subagent_type: "general-purpose",
  model: "sonnet",
  team_name: "<team_name>",
  name: "<role-1>",
  run_in_background: true
})
```

### Joiner agents (remaining roles)

Spawn all remaining roles in parallel. The prompt is the same structure with
the role's position flipped — they wait for the initiator's signal, then
confirm back.

```
Agent({
  prompt: "
You are <role-N>, a QA agent exploring a live web app at <url>.

## Your job
Use playwright-cli to control a browser. Log in or create an account using
realistic test credentials for your role (e.g. <role-N>@test.com / password123,
or register if needed).

## Playwright CLI usage
Always pass `-s=<role-N>` on every playwright-cli command. Without it, all
agents share the same browser session and will clobber each other's logins.

  playwright-cli -s=<role-N> open <url>
  playwright-cli -s=<role-N> snapshot
  playwright-cli -s=<role-N> click <ref>
  playwright-cli -s=<role-N> fill <ref> <value>
  playwright-cli -s=<role-N> goto <url>

## Scenario

<scenario>

## Coordination protocol
Wait for <role-1> to send you the information you need to join the session
(invite link, join code, session ID, etc.). Once you have it, use it to join.
Then confirm back:
  SendMessage({ to: '<role-1>', content: '<role-N> joined' })
Then continue exploring from your role's perspective.

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
When done, send: SendMessage({ to: 'team-lead', content: 'DONE' })
  ",
  subagent_type: "general-purpose",
  model: "sonnet",
  team_name: "<team_name>",
  name: "<role-N>",
  run_in_background: true
})
```

## Phase 4 — Coordination loop

This is your main loop. You receive messages from testers and act on them.

### When you receive a finding (JSON payload from any tester):

Parse the finding. Before creating a ticket, check whether it duplicates an
existing one:

```bash
tk query '.parent == "<epic-id>"'
```

**If it's a new issue**, create a ticket:

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

**If it duplicates an existing ticket**, add the new context as a note instead:

```bash
tk add-note <existing-id> "Additional report from <agent>: <description>"
```

Acknowledge the finding back to the tester (one-line SendMessage is fine).

### When you receive `DONE` from an agent:

Note it. When all agents have sent `DONE`, proceed to Phase 5.

### While waiting:

Periodically check in with agents that haven't sent anything in a while.

## Phase 5 — Completion

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
found, suggest the user install it and retry.

**Duplicate flood.** If multiple agents report the same issue, create one
ticket and note all reporters:
```bash
tk add-note <id> "Also observed by <agent>: <their description>"
```
