---
name: playwright-explore
description: >
  Spawn a team of Playwright-driven agents to explore a running web app as
  simulated users. Supports ad-hoc exploration (routes discovered from source
  code) and catalog mode (predefined scenarios loaded by name). Uses wave-based
  execution with agent recycling to prevent context exhaustion. Findings become
  tk tickets. Use when the user says "explore the app", "test the app with
  playwright", "simulate users", or similar.
argument-hint: "<url> [scenario:<name>] [roles:r1,r2,r3] [time:30m] [-- <scenario>]"
---

# Playwright Explore

You are the **team lead**. You orchestrate a live exploratory test of a running
web app using a team of simulated users. You never use the browser yourself —
your job is to plan waves, spawn agents, relay coordination messages, receive
findings, recycle agents between waves, and create tk tickets.

**Shutdown is mandatory.** Role agents keep driving the browser until you shut
them down. Never let your turn end without running the completion phase — if
you do, agents will loop indefinitely and blow their context budgets.

This skill uses `playwright-cli` (disk-backed, ~4x more token-efficient than
Playwright MCP). If `playwright-mcp` is connected in the current session, its
tool schemas cost tokens on every turn even when unused — ask the user to
disconnect it with `/mcp` before confirming the plan.

## Phase 0 — Parse arguments and confirm

Parse `$ARGUMENTS` in this order:

1. **URL** — first token (required). If missing, ask the user.
2. **Scenario catalog** — look for a `scenario:<name>` token. If present,
   enter **catalog mode** (see Phase 1B). Otherwise, **ad-hoc mode** (Phase 1A).
3. **Roles** — look for a `roles:` token (e.g. `roles:gm,player1,player2`).
   Split on commas to get the role list.
   - In catalog mode, the scenario defines roles — ignore any `roles:` token.
   - In ad-hoc mode, if `roles:` is absent, default to:
     `participant-1,participant-2,participant-3`
   - The **first role** is always the session initiator — it sets up the
     session and shares any join links or state with the other roles.
4. **Time limit** — look for a `time:` token (e.g. `time:30m`, `time:2h`).
   Parse to seconds. If absent, no limit.
5. **Freeform scenario** — everything after `--` is a free-form description
   (ad-hoc mode only). Default: "Explore the app as real users would,
   exercising the core flows end-to-end."

Derive agent names from the roles (e.g. role `gm` → agent name `gm`).

Present a short plan to the user:

**Ad-hoc mode:**
```
Mode:       ad-hoc (source-code reconnaissance)
App:        <url>
Roles:      <role-1> (initiator), <role-2>, <role-3>  [sonnet each]
Scenario:   <scenario>
Time limit: <N minutes — session ends at ~HH:MM> / none
```

**Catalog mode:**
```
Mode:       catalog
App:        <url>
Scenario:   <name> — <goal from catalog>
Roles:      <roles from catalog>  [sonnet each]
Flow steps: <N> (will map to ~<W> waves)
Time limit: <N minutes — session ends at ~HH:MM> / none
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
        description: "Build wave plan, create epic, spawn tester agents" },
      { label: "Cancel",
        description: "Stop now — nothing is created" }
    ]
  }]
})
```

The user can also pick "Other" to adjust before you proceed.

If a time limit was given, compute the deadline immediately after confirmation:

```bash
DEADLINE_TS=$(( $(date +%s) + DURATION_SECONDS ))
DEADLINE_HUMAN=$(date -r $DEADLINE_TS "+%H:%M" 2>/dev/null || date -d "@$DEADLINE_TS" "+%H:%M")
```

Record `DEADLINE_TS` and `DEADLINE_HUMAN`. If no time limit, set
`DEADLINE_TS=0` and omit the **Time limit** section from agent prompts.

## Phase 1A — Build wave plan (ad-hoc mode)

### Step 1: Source-code reconnaissance

Detect the framework and discover routes by reading source code — no browser
needed. Run a detection cascade using Glob and Grep:

| Framework | Detection | Route discovery |
|---|---|---|
| SvelteKit | `svelte.config.js` exists | `Glob("src/routes/**/+page.svelte")`, `Glob("src/routes/**/+server.ts")` |
| Next.js (app) | `next.config.*` exists | `Glob("app/**/page.tsx")`, `Glob("app/**/page.ts")` |
| Next.js (pages) | `pages/` dir exists | `Glob("pages/**/*.{tsx,ts}")` |
| FastAPI | `fastapi` in pyproject.toml/requirements | `Grep("@(app\|router)\.(get\|post\|put\|delete\|patch)", type="py")` |
| Django | `manage.py` exists | `Grep("path\\(", type="py")` in files containing `urlpatterns` |
| Express | `express` in package.json deps | `Grep("(router\|app)\\.(get\|post\|put\|delete\|patch)", type="ts")` or type="js" |

Take the first framework that returns results. If none match, use the
**generic fallback**: spawn a single short-lived scout agent (sonnet, with a
snapshot budget of 5) that opens the URL, takes a snapshot, clicks through
the top-level navigation, and reports back the list of reachable pages. Tear
the scout down before proceeding.

### Step 2: Build feature map

From the discovered routes:

1. Read a sample of each route file (first ~30 lines) to understand what
   the page does — forms, data displays, interactive elements.
2. Group routes into **feature clusters** by semantic proximity: shared URL
   prefixes, shared layouts, logical domain boundaries.
3. Note which routes likely require authentication (middleware, guards,
   redirect logic) and which are public.

Present the feature map to the user (informational — feeds into wave planning):

```
Framework: SvelteKit
Routes found: 14

Feature clusters:
  1. Auth (4 routes): /login, /register, /forgot-password, /profile
  2. Dashboard (3 routes): /dashboard, /settings, /analytics
  3. Content (4 routes): /posts, /posts/new, /posts/[id], /posts/[id]/edit
  4. Public (3 routes): /, /about, /pricing
```

### Step 3: Plan waves

Create waves from the feature clusters:

- **Wave 1** always assigns auth/login routes to the initiator role. Other
  agents in wave 1 get public or non-auth clusters.
- **Wave count**: `min(5, ceil(cluster_count / agent_count))`.
- Each agent gets one cluster per wave with a 2-4 sentence testing directive.
- Assignments name the routes and describe the flows to exercise, but leave
  room for exploratory discovery within those routes.

Present the wave plan:

```
Wave plan: 3 waves, 3 agents

Wave 1 (auth + public):
  participant-1: Auth flows — login, register, forgot-password, profile. Test
    form validation, error states, and successful auth flow.
  participant-2: Public pages — /, /about, /pricing. Check content, links,
    responsive behavior.
  participant-3: Dashboard access without auth — verify redirects work.

Wave 2 (core features — requires auth):
  participant-1: Content creation — /posts/new, /posts/[id]/edit. Test CRUD,
    form validation, error handling.
  ...

Wave 3 (edge cases):
  participant-1: Error states — 404s, permission denied, broken links.
  ...
```

Then confirm with `AskUserQuestion`:

```
AskUserQuestion({
  questions: [{
    question: "Proceed with this wave plan?",
    header: "Wave plan",
    multiSelect: false,
    options: [
      { label: "Proceed (Recommended)",
        description: "Create epic, spawn agents, begin Wave 1" },
      { label: "Cancel",
        description: "Stop now" }
    ]
  }]
})
```

The user can pick "Other" to adjust the wave plan.

## Phase 1B — Build wave plan (catalog mode)

### Step 1: Load the scenario

Search for the catalog file in this order:
1. `docs/test-scenarios.md`
2. `tests/scenarios.md`
3. `.playwright-explore/scenarios.md`

Parse the file to find the named scenario. The catalog format uses `##`
headings per scenario with structured fields:

```markdown
## <Scenario Name>
- **Roles:** <comma-separated role names>
- **Goal:** <one-line description>
- **Flow:**
  1. <step description — "chapter heading" level, not click-by-click>
  2. <step>
  ...
- **Edge cases to probe:**
  - <edge case>
  - <edge case>
```

Optional fields:
- **Auth:** notes on auth mechanism (e.g., "dev auth via ALLOW_DEV_AUTH=true")
- **Depends on:** other scenario name (if this assumes state from a prior run)

If the scenario name isn't found, list all available scenarios (the `##`
headings) and ask the user to pick one.

Extract: roles, goal, flow steps, edge cases, and any auth notes.

### Step 2: Map flow steps to waves

Each numbered flow step (or logical group of steps) becomes a wave
assignment. Use judgment to:

- Group sequential steps performed by the same role into one wave assignment
- Place steps that require cross-role coordination in the same wave (so
  agents can message each other)
- Distribute edge cases to the wave where they're most naturally tested
- Cap at 5 waves — merge smaller steps if needed

Example mapping for a 6-step scenario with 3 roles:

```
Wave 1 (setup):
  gm:      Step 1 — create game, configure settings, create advertisement
  player1: Step 2 — browse listings, find ad, submit application
  player2: Step 2 — browse listings, find ad, submit application
  Edge cases: "applying to a game that just closed its ad" → player2

Wave 2 (applications):
  gm:      Steps 3-4 — exchange DMs, accept applications, close ad
  player1: Step 3 — exchange DMs with GM, wait for acceptance
  player2: Step 3 — exchange DMs with GM, wait for acceptance

Wave 3 (gameplay):
  gm:      Step 5 — create threads, manage NPC personas
  player1: Steps 5-6 — create character, post, test dice/trackables
  player2: Steps 5-6 — create character, post, test waiting-on state
  Edge cases: "simultaneous posts", "edit after replies" → distributed
```

Present the wave plan and confirm with `AskUserQuestion` (same format as
Phase 1A Step 3).

## Phase 2 — Create epic and team

```bash
EPIC_ID=$(tk create "Playwright explore: <url> (<YYYY-MM-DD HH:MM>)" \
  -t epic -p 2 \
  --tags "playwright,exploratory-testing" \
  -d "Live exploratory test of <url>. Mode: <ad-hoc|catalog>. Scenario: <scenario>. Roles: <role list>. Waves: <N>.")
echo $EPIC_ID
```

```
TeamCreate({
  team_name: "playwright-<timestamp>",
  description: "Exploratory test team for <url>"
})
```

Note `EPIC_ID` and `team_name`.

## Phase 3 — Execute waves

Track these variables throughout the run:

- **`current_wave`** — wave number (starts at 1)
- **`total_waves`** — from the wave plan
- **`dedup_index`** — list of `{id, title}` for all tickets created
- **`coverage_summary`** — accumulated per-wave coverage (empty for wave 1)
- **`agents_done`** — set of agent names that sent DONE this wave

### Step 3.1: Spawn agents for this wave

Each agent prompt is assembled from the **shared agent prompt** (below) plus
a **wave assignment block** plus a **role delta** (wave 1 only).

Spawn all roles in parallel (single message, multiple `Agent` tool calls).
Each uses **sonnet**:

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

#### Shared agent prompt

```
You are <role>, a QA agent exploring a live web app at <url>.

## Your job
Use playwright-cli to control a browser. Your assignment for this wave is
described below — complete it and send DONE.

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

**Never pipe `playwright-cli` output through `head`, `tail`, `grep`, or any
other command that closes the pipe early.** `playwright-cli` is a Rust binary
and panics on `SIGPIPE`, dumping a `thread 'main' panicked … Broken pipe`
trace plus the full page YAML into your transcript on every call. This is the
fastest way to blow your context budget. If you want to truncate a large
snapshot, write it to a file with `--filename` and (only if you truly need to
look at it) `Read` a bounded range. Do not run
`playwright-cli ... | head -N` under any circumstance.

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
  Always write snapshot files under `.playwright-cli/snapshots/` (which is
  already gitignored via `.playwright-cli/`), e.g.
  `--filename .playwright-cli/snapshots/<role>-<label>.yml`. Never write
  them to the repo root.

## Snapshot budget

You have a budget of approximately 15 snapshots for this wave assignment.
Each `playwright-cli snapshot` (whether inline or to file) counts as 1.
Track your count mentally. When you reach ~13:
- Wrap up your current flow
- Send any remaining findings
- Send DONE

This is a heuristic, not a hard limit — if you're mid-flow and one more
snapshot would complete a finding, take it. But do not start a new flow
after hitting the budget.

## Screenshots

Don't take screenshots unless you're verifying a visual bug. When you must:
- They land in `.playwright-cli/` as PNG files.
- **Never `Read` a screenshot** — you don't need to see pixels to file a bug.
  Cite the file path in your finding and move on.

## Auth persistence

After a successful login, always save state for future waves:
  playwright-cli -s=<role> state-save .playwright-cli/<role>-auth.json

This is mandatory — other waves depend on your saved auth state.

<AUTH_BLOCK — see below>

## Scenario context

<SCENARIO_CONTEXT — goal and overall scenario description>

## Your assignment (Wave <N>)

<WAVE_ASSIGNMENT — see below>

<ROLE_DELTA — wave 1 only, see below>

## Previously covered

<COVERAGE_SUMMARY — empty for wave 1>

## Staying reachable (critical)

The team lead must be able to redirect you at any time. Two hard rules:

1. **Check your inbox before every `playwright-cli` command.** If there is a
   message from `team-lead`, read it and act on it *before* running the next
   playwright action. Never run more than one playwright-cli command without
   first checking for new messages.
2. **Heartbeat at least once per minute.** If ~60 seconds have passed since
   your last message to the team lead, send a STATUS update before your
   next action, even if nothing notable has happened:
     SendMessage({ to: 'team-lead', message: 'STATUS <role>: <what you are doing now>' })

**SendMessage payloads must always be strings.** The tool's field is `message`
(not `content`), and its value must be a plain string. For structured
findings, wrap the object in `JSON.stringify(...)` — never pass a raw object
like `message: { title: ... }` or you'll get `InputValidationError: expected
string, received object`.

Also send a STATUS after each milestone (logged in, completed a flow) — but
the two rules above are the floor, not the milestones. Going silent for
minutes is a bug, not focus.

## Time limit
Deadline: <DEADLINE_TS> (unix epoch) — approximately <DEADLINE_HUMAN>

At every heartbeat, check the current time before continuing:
  date +%s

- **Within 120 seconds of deadline**: finish your current action, then wrap
  up — do not start any new major flow.
- **At or past the deadline**: flush everything and send DONE (see below).

**Wrapping up when time is up or assignment is complete:**
1. Save your auth state:
   playwright-cli -s=<role> state-save .playwright-cli/<role>-auth.json
2. Send any observations you haven't reported yet.
3. For anything you suspected but didn't have time to verify, send a theory
   finding:
   SendMessage({
     to: 'team-lead',
     message: JSON.stringify({
       title: '<short title>',
       description: 'Theory — not yet verified: <what you suspect, why, and how you would verify it>',
       severity: '<your best estimate>',
       confidence: 0.1-0.3,
       tags: ['theory', 'unexplored', ...]
     })
   })
4. Send DONE:
   SendMessage({ to: 'team-lead', message: 'DONE' })

## Shutdown
If you receive a `shutdown_request` or TIME_UP message from the team lead,
finish your current action, save auth state, flush any unsent findings and
theories, then reply:
  SendMessage({ to: 'team-lead', message: 'SHUTDOWN_ACK <role>' })
Then stop.

## Reporting findings
Whenever you notice something broken, confusing, missing, or worth improving,
send a structured finding to the team lead:
  SendMessage({
    to: 'team-lead',
    message: JSON.stringify({
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
```

#### Auth block — wave 1

```
At startup, if .playwright-cli/<role>-auth.json exists, try loading it:
  playwright-cli -s=<role> state-load .playwright-cli/<role>-auth.json
If it works (not redirected to login), skip the login flow.
Otherwise, log in or create an account using realistic test credentials
(e.g. <role>@test.com / password123, or register if needed).
<AUTH_NOTES — from catalog if present, e.g. "dev auth via ALLOW_DEV_AUTH=true">
```

#### Auth block — wave 2+

```
Load your saved auth state before visiting the app:
  playwright-cli -s=<role> state-load .playwright-cli/<role>-auth.json
  playwright-cli -s=<role> goto <url>
If the state is stale (redirected to login), re-authenticate and re-save.
You do not need to wait for other agents — auth was established in wave 1.
<AUTH_NOTES — from catalog if present>
```

#### Wave assignment block — ad-hoc mode

```
<2-4 sentence directive from wave plan>

Routes to cover: <route_list>

When you have tested these routes and their main flows, send DONE.
Do not explore outside your assigned routes unless you discover a bug
that requires following a link to reproduce it.
```

#### Wave assignment block — catalog mode

```
Scenario: <scenario name>

Your steps this wave:
  <flow step descriptions from catalog>

Edge cases to probe:
  <relevant edge cases from catalog, or "none assigned this wave">

When you have completed these steps and probed the edge cases, send DONE.
```

#### Role delta — initiator (wave 1 only, first role)

Insert after the wave assignment block:

```
## Coordination protocol (initiator)
You go first. Once you have set up the session and have information the
other agents need to join or participate (invite links, join codes, session
IDs, URLs, etc.), send it to each of them:
  SendMessage({ to: '<role-2>', message: '<the info>' })
  SendMessage({ to: '<role-3>', message: '<the info>' })
Wait for them to confirm before continuing steps that require their presence.
They will message you when they've completed a coordination step.
```

#### Role delta — joiner (wave 1 only, remaining roles)

Insert after the wave assignment block:

```
## Coordination protocol (joiner)
Wait for <role-1> to send you the information you need to join the session
(invite link, join code, session ID, etc.). Once you have it, use it to join,
then confirm back:
  SendMessage({ to: '<role-1>', message: '<role> joined' })
Then continue with your assignment from your role's perspective.
```

#### Coverage summary

For wave 1, this section reads: `No prior waves — this is wave 1.`

For wave 2+, the team lead builds this from the previous waves' outcomes:

```
Do not re-test these unless your assignment explicitly overlaps:

Wave 1:
  <role>: <assignment summary>. Findings: <one-line per finding, or "none">.
  <role>: <assignment summary>. Findings: <one-line per finding, or "none">.
Wave 2:
  ...

Total tickets created so far: <N>
```

Keep it terse — route + who tested it + one-line finding. Agents can
`tk show <id>` if they need detail.

### Step 3.2: Coordination loop

This is your main loop within a wave. You receive messages from testers and
act on them.

**Maintain the dedup index** across all waves — it persists in the team
lead's context. Compare incoming findings against this list. Do not re-query
`tk` for every finding.

#### When you receive a finding (JSON payload from any tester):

Parse the finding. Compare its `title` (case-insensitive, fuzzy) against the
dedup index.

**If it's a new issue**, create a ticket and append `{id, title}` to the index:

```bash
tk create "<title>" \
  -t bug \
  -p <priority> \
  --parent $EPIC_ID \
  --tags "<tags from finding, plus 'playwright'>" \
  -d "<description>

Confidence: <confidence score> (<rationale>)

Reported by: <agent-name> (Wave <N>)

## Acceptance Criteria (EARS format)
- When <trigger>, the system shall <behavior>.
- While <state>, the system shall <behavior>.
- The system shall <behavior>.
[Write 2-4 ACs that would verify the issue is fixed]"
```

**If it duplicates an existing ticket**, add context as a note:

```bash
tk add-note <existing-id> "Additional report from <agent> (Wave <N>): <description>"
```

Acknowledge the finding back to the tester (one-line SendMessage is fine).

#### When you receive `DONE` from an agent:

Add the agent to `agents_done`. When all agents in this wave have sent
`DONE`, proceed to Step 3.3.

#### When you receive `STATUS` from an agent:

Acknowledge if needed. Update the dashboard.

#### Timestamping inbound messages

Every time you quote or summarize an agent's message to the user, prefix it
with the local clock time you received it, e.g.
`[14:32:05] player-1: STATUS — testing post creation form`. Track each
agent's most recent message time ("last heard") so you can spot stalls.

#### Heartbeat cadence (active monitoring)

Agents are required to STATUS at least once per minute. If they stop, act:

- **~2 minutes of silence from any agent**: send a one-line ping —
  `SendMessage({ to: '<role>', message: 'ping — still alive? what are you doing?' })`.
- **~5 minutes with no progress** on the same action: use `TaskOutput`
  against that agent's task to inspect what it's actually doing. Hook
  failures, stuck playwright commands, and orphaned confirmation prompts
  show up there.
- Report sweep results to the user, prefixed with the clock time.

Don't passively wait — if you haven't heard from anyone in a while and the
wave isn't done, assume something is stuck and investigate.

#### Status dashboard

Output a status dashboard to the user every time agent or wave state changes:

```
── Wave 2: player1 DONE ────────────────────────────────

**Agents**

| Agent | State | Assignment | Last heard |
|---|---|---|---|
| gm | exploring | Accept apps, close ad | 14:31:02 |
| player1 | done | DM with GM, await accept | 14:29:47 |
| player2 | exploring | DM with GM, await accept | 14:30:55 |

**Waves**

| Wave | Status | Findings |
|---|---|---|
| Wave 1 | complete | 2 tickets |
| Wave 2 | active (1/3 done) | 1 ticket |
| Wave 3 | pending | |

Progress: 3 tickets · Wave 2: 1/3 agents done

─────────────────────────────────────────────────────────
```

#### Time enforcement

If a `time:` limit was specified, check the deadline after processing each
incoming message:

```bash
date +%s
```

If `now >= DEADLINE_TS` and any agents haven't sent `DONE` yet, send TIME_UP
to each still-active agent:

```
SendMessage({ to: '<role-N>', message: 'TIME_UP — time limit reached. Save auth state, flush your outstanding findings and any unexplored theories, then send DONE.' })
```

Give agents up to 2 minutes to complete their flush. After that, proceed to
wave completion with whoever has reported in.

If `DEADLINE_TS` is approaching and there are remaining waves, the team lead
should skip remaining waves and proceed directly to completion — don't start
a wave that will immediately time out.

### Step 3.3: Wave completion

When all agents in this wave have sent `DONE` (or TIME_UP flush is complete):

1. **Build coverage summary** for this wave — for each agent, note what they
   tested and a one-line summary of each finding. Append to the running
   `coverage_summary`.

2. **Announce to the user:**
   ```
   Wave <N>/<total> complete. <M> findings this wave, <T> total.
   ```

3. **If more waves remain and time permits:**
   - Shut down all agents:
     ```
     SendMessage({ to: '<role-1>', message: 'type: shutdown_request' })
     SendMessage({ to: '<role-2>', message: 'type: shutdown_request' })
     ...
     ```
   - Wait up to 60 seconds for `SHUTDOWN_ACK` from each. If an agent
     doesn't respond, use `TaskStop` on its task.
   - Increment `current_wave`, reset `agents_done` to empty.
   - Spawn fresh agents for the next wave (Step 3.1) with updated coverage
     summary and the next wave's assignments.
   - Wave 2+ agents use the **wave 2+ auth block** (load saved state) and
     have **no role deltas** (initiator/joiner distinction only applies to
     wave 1).

4. **If this was the last wave** (or deadline reached): proceed to Phase 4.

## Phase 4 — Completion

1. Summarize the session from the dedup index and coverage summary.

2. Report to the user:

```
Exploratory session complete.

Epic: <epic-id>
Scenario: <name or "ad-hoc">
Waves completed: <N>/<total>
Tickets created: <T>
  Wave 1 (<label>): <M> tickets
    [<id>] <title> (priority: <p>, confidence: <c>)
    ...
  Wave 2 (<label>): <M> tickets
    ...

Suggested next steps:
  tk ready                          # see what's unblocked
  /run-epic <epic-id>               # implement fixes
  tk show <id>                      # review individual tickets
```

3. Shut down any remaining agents:

```
SendMessage({ to: '<role-1>', message: 'type: shutdown_request' })
SendMessage({ to: '<role-2>', message: 'type: shutdown_request' })
...
```

Wait for `SHUTDOWN_ACK` from each (up to 60 seconds). If a teammate hasn't
responded, use `TaskStop` on its background task. Only then:

```
TeamDelete()
```

Do **not** end your final turn before `TeamDelete()` returns — role agents
left alive will continue driving the browser until they blow their context
budgets.

## Scenario Catalog Format

Projects can create a scenario catalog file for reusable test definitions.
The skill searches for it in: `docs/test-scenarios.md`,
`tests/scenarios.md`, `.playwright-explore/scenarios.md`.

Format — markdown with `##` headings per scenario:

```markdown
## Public Game Lifecycle
- **Roles:** gm, player1, player2
- **Goal:** Test the full public game flow from creation through active play.
- **Auth:** dev auth via ALLOW_DEV_AUTH=true
- **Flow:**
  1. GM creates a game, configures trackable fields, creates an advertisement
  2. Players browse /lfp, find the ad, submit applications
  3. GM and applicants exchange direct messages
  4. GM accepts applications, closes the ad
  5. GM creates IC and OOC threads, players create characters
  6. Everyone posts — test dice rolls, character trackables, NPC personas
- **Edge cases to probe:**
  - Player applies to a game that just closed its ad
  - Simultaneous posts in the same thread
  - Editing/deleting posts after others have replied

## Private Game (Invite Link)
- **Roles:** gm, player1
- **Goal:** Test the invite-link join flow (no advertisement/application).
- **Flow:**
  1. GM creates a game (not public)
  2. GM generates an invite link
  3. Player uses the invite link to join directly
  4. Standard in-game flow: threads, posts, characters, trackables
- **Edge cases to probe:**
  - Using an invite link when already a member
  - Using an expired or invalid invite token
```

Required fields: **Roles**, **Goal**, **Flow**. Optional: **Auth**,
**Edge cases to probe**, **Depends on** (other scenario name).

Flow steps should be "chapter headings" — describe *what* to do, not *how*
to click. Agents figure out the specific interactions. Too much detail
defeats the purpose of exploratory testing.

## Edge Cases

**Agent can't connect to the app.** If an agent reports connection failure
in wave 1, stop immediately and tell the user the app doesn't appear to be
running at `<url>`.

**Coordination stall (wave 1).** If joiners are waiting and the initiator
hasn't sent anything, prompt it directly:
```
SendMessage({ to: '<role-1>', message: 'Other agents are waiting — have you set up the session yet?' })
```

**playwright-cli not available.** If a tester reports `playwright-cli` isn't
found, suggest the user install it and retry. Point them at
`playwright-cli install --skills` which registers it as a Skill so its command
schemas aren't loaded into the model context at startup.

**Duplicate flood.** If multiple agents report the same issue, create one
ticket and note all reporters:
```bash
tk add-note <id> "Also observed by <agent> (Wave <N>): <their description>"
```

**Agent hits snapshot budget before completing assignment.** This is expected
and fine — the agent will report what it tested and send DONE. Any untested
routes from its assignment will be visible in the coverage summary. If
coverage gaps matter, the team lead can add a cleanup wave at the end that
targets only the uncovered routes.

**No catalog file found in catalog mode.** Tell the user no scenario catalog
was found. List the search paths and suggest creating one at
`docs/test-scenarios.md`. Offer to fall back to ad-hoc mode.

**Scenario name not found in catalog.** List all available scenario names
(the `##` headings) and ask the user to pick one.

**Auth state stale in wave 2+.** Agents are instructed to re-authenticate
and re-save if `state-load` doesn't work. If multiple agents report auth
failures, there may be a session timeout issue — note it as a finding.

**User wants to stop mid-session.** Shut down all agents (shutdown_request),
wait for acks, `TeamDelete`. Report what was completed so far. In-progress
tickets remain open.
