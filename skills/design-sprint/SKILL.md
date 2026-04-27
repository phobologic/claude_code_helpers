---
name: design-sprint
description: >
  Run a multi-agent GAN-style design sprint to produce a frontend design
  specification. Three designer agents (sonnet) propose independently across
  three rounds of increasing concreteness; a persistent evaluator (opus) scores
  each round and issues a shared brief; the team lead writes the final spec.
  Use when the user says "design sprint", "come up with a design", "generate a
  design spec", or similar.
argument-hint: "[--scan] [--output <path>] [-- <guidance>]"
model: sonnet
---

# Design Sprint

You are the **team lead**. You orchestrate a three-round design sprint that
produces a frontend design specification for this codebase. You never design
yourself — you gather context, route proposals, and write the final spec file
from the evaluator's synthesis.

## Scoring criteria (know these — you'll reference them throughout)

| Criterion | Weight | What it means |
|---|---|---|
| Design Quality | 35% | Coherent whole — colors, type, layout, imagery combine into a distinct mood and identity |
| Originality | 30% | Deliberate custom decisions, not template layouts, library defaults, or AI-generated patterns |
| Functionality | 25% | Usability independent of aesthetics — clear purpose, findable actions, completable tasks |
| Craft | 10% | Technical fundamentals — type hierarchy, spacing consistency, color harmony, contrast ratios |

## Phase 0 — Parse arguments

Parse `$ARGUMENTS`:

- `--scan` — take playwright-cli screenshots of the running app before starting.
  Look for a dev server URL in `package.json` scripts or ask the user if unclear.
- `--output <path>` — where to save the final spec. Default: `docs/design-spec.md`
- Everything after `--` is free-form guidance to include in the context brief.

## Phase 1 — Gather context

Run these in parallel:

**Codebase scan** — collect the following into a context brief:

```bash
# Framework and dependencies
cat package.json 2>/dev/null || cat pyproject.toml 2>/dev/null

# Existing style/theme files
find . -name "*.css" -o -name "tailwind.config*" -o -name "theme.*" \
  | grep -v node_modules | grep -v .git | head -20

# Component directory structure
find . -type d -name "components" | grep -v node_modules | head -5
```

Read any existing global CSS, theme config, or design token files you find.
Summarize into a context brief with:
- Framework and UI library (e.g. React + Tailwind, Vue + shadcn, etc.)
- Where components live
- Any existing color tokens, fonts, or design decisions already in place
- What the app does (from README or package.json description)
- User-provided guidance (from `--` argument)

**Playwright scan** (only if `--scan` was passed):

```bash
# Take screenshots of the main app and a few linked pages
playwright-cli screenshot <url> /tmp/design-sprint/screen-home.png
```

Navigate to 2–3 additional routes visible in the app's nav and screenshot each.
Save to `/tmp/design-sprint/`. These will be included in the context brief so
agents can see the current visual baseline.

Present the context brief to the user and confirm before proceeding.

## Phase 2 — Spawn the team

### Create the team namespace

```
TeamCreate({
  team_name: "design-sprint-<timestamp>",
  description: "Design sprint for <repo name>"
})
```

### Spawn the evaluator first

The evaluator (opus, effort: high — see `agents/design-evaluator.md`) persists
across all three rounds. It accumulates scoring history, which gives it
consistency across rounds.

```
Agent({
  prompt: "You are the evaluator for this design sprint. Wait for the team lead to send you the three Round 1 proposals.",
  subagent_type: "design-evaluator",
  team_name: "<team_name>",
  name: "evaluator",
  run_in_background: true
})
```

### Spawn the three designers in parallel

Designers (sonnet — see `agents/design-designer.md`). Each spawn passes the
designer number and the full context brief from Phase 1 — that's all the
dynamic context the agent body needs.

```
Agent({
  prompt: "You are designer-N. Wait for the team lead's Round 1 start message before producing anything.

## App context

<full context brief from Phase 1, including screenshots if available>",
  subagent_type: "design-designer",
  team_name: "<team_name>",
  name: "designer-N",
  run_in_background: true
})
```

Spawn designer-1, designer-2, and designer-3 in parallel.

## Phase 3 — Round 1

Send the start message to all three designers simultaneously:

```
SendMessage({
  to: 'designer-1',
  content: 'Round 1 starting. Produce your Round 1 proposal (mood/direction/identity). No hex values or specific fonts yet — focus on the experience and point of view.'
})
```

Repeat for designer-2 and designer-3.

Wait for all three to send their proposals back. As each arrives, hold it — do
not forward until all three are in hand.

## Phase 4 — Round 1 evaluation

Once all three Round 1 proposals are received, send them to the evaluator:

```
SendMessage({
  to: 'evaluator',
  content: 'Round 1 proposals ready for scoring. Here are all three:

DESIGNER-1:
<proposal>

DESIGNER-2:
<proposal>

DESIGNER-3:
<proposal>

Please score all three and issue the Round 2 brief.'
})
```

Wait for the evaluator's response (scores + Round 2 brief).

Share the scores and brief with the user:

```
Round 1 complete.

Scores:
  designer-1: X.X/10
  designer-2: X.X/10
  designer-3: X.X/10

Round 2 brief issued. Starting Round 2...
```

## Phase 5 — Round 2

Send each designer the Round 2 brief **plus all three Round 1 proposals** so
they have full context for what the evaluator is referencing:

```
SendMessage({
  to: 'designer-1',
  content: 'Round 2 starting. Focus: the system — specific palette, type choices, spacing, component style.

EVALUATOR BRIEF:
<round 2 brief from evaluator>

ALL ROUND 1 PROPOSALS (for context):

DESIGNER-1 (yours):
<proposal>

DESIGNER-2:
<proposal>

DESIGNER-3:
<proposal>'
})
```

Repeat for designer-2 and designer-3 (each receives the same brief and all
three Round 1 proposals).

Wait for all three Round 2 proposals.

## Phase 6 — Round 2 evaluation

Same as Phase 4 — send all three Round 2 proposals to the evaluator and
request scores + Round 3 brief.

Share scores with the user before proceeding.

## Phase 7 — Round 3

Same pattern as Phase 5 — send each designer the Round 3 brief plus all
three Round 2 proposals.

Round 3 instruction to include in the message:

> Round 3 is spec-ready. Produce something a developer can implement directly:
> actual hex codes, exact font names and weights, pixel values, explicit rules.
> Draw on the best elements from all Round 2 proposals — this is convergence.

Wait for all three Round 3 proposals.

## Phase 8 — Final evaluation and synthesis

Send all three Round 3 proposals to the evaluator and request the final
synthesis:

```
SendMessage({
  to: 'evaluator',
  content: 'Round 3 (final) proposals ready. Please score all three and produce
the complete design specification synthesis.

DESIGNER-1:
<proposal>

DESIGNER-2:
<proposal>

DESIGNER-3:
<proposal>'
})
```

Wait for the evaluator's synthesis.

## Phase 9 — Write the design spec

Take the evaluator's synthesis and write it to the output path (default:
`docs/design-spec.md`). Create the directory if it doesn't exist.

Add a header to the file:

```markdown
# Design Specification

> Generated by design-sprint on <date>
> Rounds: 3 | Designers: 3 (sonnet) | Evaluator: opus
> Final scores — designer-1: X.X | designer-2: X.X | designer-3: X.X

<evaluator synthesis>
```

Then report to the user:

```
Design sprint complete.

Spec written to: <output path>

Final scores:
  designer-1: X.X/10
  designer-2: X.X/10
  designer-3: X.X/10

Winning direction: <one sentence summary>

Next steps:
  - Review the spec: cat <output path>
  - Implement it: /frontend-design (reference the spec in your prompt)
  - Refine: re-run /design-sprint with guidance via -- to push a specific direction
```

## Phase 10 — Cleanup

```
SendMessage({ to: 'designer-1', content: 'Sprint complete. Shutting down.' })
SendMessage({ to: 'designer-2', content: 'Sprint complete. Shutting down.' })
SendMessage({ to: 'designer-3', content: 'Sprint complete. Shutting down.' })
SendMessage({ to: 'evaluator',  content: 'Sprint complete. Shutting down.' })
TeamDelete()
```

## Edge Cases

**Designer produces a proposal that ignores the brief.** Note it in your
round summary to the user, but don't discard it — the evaluator will score it
lower and the brief will course-correct.

**Two designers converge on nearly identical proposals.** The evaluator will
flag this. Don't intervene — let the evaluator's brief push them apart in the
next round.

**Evaluator's synthesis omits required sections.** Before writing the file,
check that all sections (palette, typography, spacing, components, do/don't)
are present. If any are missing, send a follow-up to the evaluator asking it
to complete those sections.

**`--scan` fails (app not running).** Warn the user and continue without
screenshots. Don't stop the sprint.

**User wants to stop mid-sprint.** Send shutdown to all agents, TeamDelete,
and tell the user what was completed. Any round that finished fully can be
retrieved from the evaluator's last message.
