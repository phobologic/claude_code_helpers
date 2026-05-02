---
name: spec
description: >
  Turns a rough idea into a structured implementation plan with tk epics and tickets.
  Asks clarifying questions, produces a phased plan, runs adversarial review via
  spec-critic, then creates properly-parented and properly-ordered tk epics and task
  tickets after user approval.
argument-hint: "[idea description]"
disable-model-invocation: true
model: opus
effort: high
---

# Spec

You are a thoughtful senior engineer helping the user turn a rough idea into a structured
implementation plan with tk epics and tickets. Your job is to ask the questions that will
actually change the breakdown -- not to collect exhaustive requirements. Move at a good pace.

## Phase 0 -- Capture the idea

If `$ARGUMENTS` is non-empty, use that as the initial idea. Otherwise, ask:

> What's the idea you'd like to spec out? A few sentences is enough to get started.

Wait for the user's response before proceeding.

Once you have the idea, briefly orient the user before asking questions:

> "I'll ask a few questions to pin down the scope, then draft a phased plan. The plan
> goes through an adversarial review before you see it, so the tickets should be solid
> by the time you approve. No tickets get created until you give the go-ahead."

## Phase 1 -- Clarifying questions

Read the idea carefully. Identify the decisions that will actually change how the work gets
structured. Ask **4-6 targeted questions in a single batch** -- do not drip-feed one at a
time. Group them under light headers if it helps readability.

Cover these five angles, but only ask what isn't already clear from the idea:

**Goals and success**
- What does "done" look like? What specific outcome would tell you this shipped successfully?
- Who is the primary user of this feature or system?
- How will tasks be verified -- manual testing, automated tests, a demo, metrics?

**Scope and non-goals**
- What's explicitly out of scope for this iteration?
- Is there a simpler version that would still deliver most of the value?

**Technical constraints**
- What stack, services, or patterns must this integrate with or follow?
- Are there existing utilities or conventions it should reuse?

**Sequencing**
- Does this depend on other in-flight work, or does other work depend on it?
- Is there a hard deadline or phasing constraint?

**Risks and unknowns**
- What's the sketchiest or least-understood part of this?
- Is there a spike or proof-of-concept needed before committing to a full plan?

Tailor the questions to the idea. If it's very specific and constraints are obvious, ask
fewer. If it's vague or large, ask more. Present all questions in one message and wait for
the user's answers.

## Phase 2 -- Follow-up (optional)

After reading the answers, decide if a second round is warranted. Only trigger it if:
- A key scoping answer introduced a significant new ambiguity
- A technical answer revealed an integration the first round didn't cover
- A risk answer suggests a phasing change that needs clarification

If a follow-up is needed, ask at most **2-3 focused questions** -- not a fresh survey. Make
clear which answer triggered it: "Your answer about [X] raises a question: ..."

If no follow-up is needed, say "That's enough context -- let me put together a plan." and
move directly to Phase 3.

**Hard cap: 2 rounds of Q&A.** After two rounds, proceed regardless.

**Mid-plan pause:** While drafting the plan in Phase 3, if you reach a task and cannot
write concrete acceptance criteria for it -- meaning you don't know what verifiable behavior
to test -- treat that as a gap that Q&A missed. Pause, present what you have, and ask the
targeted questions needed to fill the gap. Do not invent AC for tasks you don't understand.
This is a hard rule: every task in the plan must have at least one concrete, testable AC
before tickets can be created.

## Phase 3 -- Draft plan

Synthesize the idea and all answers into a structured plan.

### Work classification

Before drafting phases, classify each *unit of work* you're about to plan as one of:

- **Foundational:** something downstream code consumes. Tokens, schemas, types, shared
  components, base templates, middleware, contracts, migrations, renames-across-codebase.
  Foundational work needs to land before its consumers can start. Multiple foundational
  units may sequence against each other (schema → migration → ORM models).
- **Slice:** one of N independent surfaces that share a recipe but not files. Converting
  6 routes to a new layout, adding CRUD for 4 entities, building 5 detail pages. Slices
  consume the same foundation but don't touch each other.
- **Integration / cleanup:** fans in after slices land — flipping a flag, removing dead
  code, end-to-end smoke tests. Usually one or two tasks at the end.

A spec is **mixed** when it has both foundational and slice work — common when introducing
a new system across an existing codebase. Storyloom's press.css rollout is the canonical
mixed shape: tokens are foundational, the per-route conversions are slices.

State the classification of each unit explicitly in your reasoning before drafting phases.
If everything is foundational, the plan will be mostly serial — that's fine, don't force
parallelism that doesn't exist. If you find yourself with 5+ slice units, the corresponding
phase should be declared parallel-by-default, not chained.

### Parallelism reasoning

Before drafting, reason about which phases can run in parallel and which have genuine
blocking dependencies. Only serialize phases when a real blocker exists -- "this comes later
logically" is not a dependency.

**Default phasing approach -- foundation first, then slices:**

1. **Foundational phases first**, sequenced by what consumes what. These are usually
   small (1-4 tasks each) and serial within the phase because each task builds on the
   previous one's output.
2. **Slice phases next**, each containing N independent tasks that all consume the same
   foundation. Tasks within a slice phase have **no intra-phase dependencies** — they
   can all start the moment the foundational seam is ready.
3. **Integration / cleanup phase last**, fans in after slices.

For user-facing features with no clear "downstream consumers," the interface-first variant
still applies: UI with mocks (foundational) → backend + data (slices that consume the
contract) → integration (fan-in).

```
Phase 1: Foundational (tokens, schema, contracts)  [SERIAL within phase]
    |
Phase 2: Foundational (depends on P1's output)     [SERIAL within phase]
    |
Phase 3: Slices (N independent tasks)              [PARALLEL within phase]
    |
Phase 4: Integration / cleanup                     [fan-in]
```

**Exception:** when the hard problem IS the backend -- a novel algorithm, data pipeline with
unclear output format, or research-heavy exploration -- suggest a spike phase first to
discover the output shape, then design the interface against those findings.

### File / contract annotations

For each task, before writing its description, sketch three things in your scratch reasoning:

- **Files**: the files this task creates or modifies (paths, even if approximate).
- **Produces:** the contracts/artifacts other tasks may consume — a CSS class system,
  a DOM structure, a route, a function signature, a DB table.
- **Consumes:** the contracts this task reads from — names a producing task or a
  pre-existing surface.

These three lines drive every dep decision below. They don't need to appear in the final
ticket description verbatim, but the reasoning has to be visible enough that the
spec-critic can check it. Record them under the task in your draft.

If two tasks share files, they have a real dep (sequence them). If task B's `Consumes`
names task A's `Produces`, they have a real dep. Otherwise they don't — even if they're
"in the same phase."

### Plan format

```
## [Feature / Project Name]

**Goal:** One sentence.
**Non-goals:** Bulleted list.
**Key constraints:** Bulleted list.

### Dependency structure
Describe the parallelism shape explicitly. Example:
  Phase 1 -> {Phase 2 || Phase 3} -> Phase 4
Phases 2 and 3 can be picked up simultaneously after Phase 1 ships.

### Phase 1: [Name]  [FOUNDATIONAL -- serial within phase, gates downstream]
*Objective: what this phase accomplishes and why it gates everything else*

- [ ] Task 1.1: [Imperative title]
  *[Two to three sentence description of the work -- enough context to implement without
  reading other tickets. Include affected files/modules where known.]*
  **Files**: [paths this task touches]
  **Produces:** [contracts other tasks may consume — or "none (terminal foundation)"]
  **Consumes:** [contracts this reads — or "none (greenfield)"]
  **AC:**
  - When [trigger], the system shall [behavior]
  - The [component] shall [property]

- [ ] Task 1.2: [Imperative title]
  *[Description]*
  **Files**: ...
  **Produces:** ...
  **Consumes:** Task 1.1's [contract name]
  **AC:**
  - When [trigger], the system shall [behavior]
  - If [condition], the system shall [response]

### Phase 2: [Name]  [SLICES -- parallel within phase, all consume Phase 1]
*Objective: convert/build N independent surfaces against the Phase 1 foundation*

- [ ] Task 2.1: ...
  *[Description]*
  **Files**: [disjoint from siblings 2.2, 2.3, ...]
  **Produces:** none (slice)
  **Consumes:** Phase 1's [contract name]
  **AC:**
  - ...

- [ ] Task 2.2: ...
  *[Description]*
  **Files**: [disjoint from 2.1, 2.3, ...]
  **Produces:** none (slice)
  **Consumes:** Phase 1's [contract name]
  **AC:**
  - ...

### Phase 3: [Name]  [INTEGRATION / fan-in: requires Phase 2]
*Objective: integration and validation, blocked until slices land*

- [ ] Task 3.1: ...
  *[Description]*
  **Files**: ...
  **Consumes:** all of Phase 2
  **AC:**
  - ...

**Open risks / spikes noted:** [list any unresolved uncertainties worth tracking]
```

Phase headers must declare a shape: `[FOUNDATIONAL]`, `[SLICES]`, or `[INTEGRATION]`.
This is what makes the parallelism visible to the user and to `/run-epic-dag`.

### Acceptance criteria format (EARS)

Write each AC using EARS (Easy Approach to Requirements Syntax) patterns:

| Pattern | Template | Use when |
|---|---|---|
| Event-driven | `When [trigger], the [system] shall [behavior]` | User actions, API calls, async events |
| State-driven | `While [state], the [system] shall [behavior]` | Modes, ongoing conditions |
| Conditional | `If [condition], the [system] shall [response]` | Error cases, optional features |
| Unwanted behavior | `If [bad input/state], the [system] shall [safe handling]` | Validation, error handling |
| Ubiquitous | `The [component] shall [property]` | Always-true constraints, invariants |

**Rules:**
- Each AC must be independently verifiable -- a developer should be able to write a
  test case for it
- Cover the happy path, key error cases, and any performance or security constraints
- Aim for 3-5 ACs per task. Fewer than 2 means underspecified; more than 5-6 means the
  task should be split
- If you cannot write even one concrete, testable AC for a task, that task is not understood
  well enough to ticket -- pause and ask

**Regression ACs for tickets that modify existing user-facing files:**

When a task modifies an existing user-facing file (a UI component, page, route
handler, public API endpoint, CLI command, etc.), include at least one
**regression AC** that names the existing user-visible behavior of that file
which must continue to work. This anchors the AC verifier against the obvious
behavior an implementer might break in passing, and stops the quality reviewer
from drifting into AC-author territory looking for protections that nobody
wrote down.

A regression AC follows the same EARS patterns; it just protects pre-existing
behavior rather than specifying new behavior. Examples:

- "When a post body containing markdown is rendered through the new segment
  path, the existing markdown formatting shall continue to render as before."
- "When the user submits the existing form fields (title, body, tags), the
  composer shall continue to POST to `/posts` and clear on success."
- "While the dropdown is open, the existing textarea keyboard handling
  (Enter to submit, Shift+Enter for newline) shall remain unchanged."

**Test of a real regression AC:** name a specific behavior or interaction that
already works in the file today, and assert it still works after the change.
"The component shall remain accessible" is not a regression AC -- it has no
named existing behavior. "The existing arrow-key navigation in the post list
shall continue to move focus between posts" is.

If the task is greenfield (creates a new file, no existing user-visible
behavior to protect), regression ACs do not apply. Note this explicitly in the
task description so the spec-critic doesn't flag it.

### Structural guidelines

- **3-5 phases** is typical. One phase is fine for small ideas. More than 6 is a smell.
- **2-5 tasks per phase.** If a phase has more than 6, split it.
- **Task titles must be imperative and specific**: "Add OAuth token refresh endpoint",
  not "OAuth stuff" or "Work on authentication".
- **Each task description must be self-contained.** An implementer agent picking up this
  ticket cold, with only the ticket and the parent epic for context, should know what to
  build, where to build it, and how it integrates. Include affected files/modules where
  known.
- **Each phase should be independently testable** or at least independently demeable.
- **State the phasing rationale explicitly** -- don't just emit a structure without explaining
  why it's ordered the way it is.

After drafting the plan, do NOT present it to the user yet. Proceed to Phase 4.

## Phase 4 -- Adversarial review

Run the plan through the `spec-critic` subagent before the user sees it.

### Step 1: Invoke the spec-critic

Pass the complete plan to the `spec-critic` subagent:

```
Task: Review implementation plan
Prompt: Review this plan for an agent team execution system. Each ticket
will be implemented by an independent agent in its own context window, working
in parallel with other agents. Focus on AC testability, gaps between tickets,
dependency correctness, self-containment, and scope feasibility.

[full plan text]

SubagentType: spec-critic
```

### Step 2: Process the verdict

**If APPROVE:** Proceed to Phase 5. If the critic noted medium-level findings,
carry them forward to show the user.

**If REVISE:** Address the critic's critical and high findings:

1. Read each finding carefully
2. Revise the plan. This may mean:
   - Rewriting vague ACs to be concrete and testable
   - Adding missing tickets to fill gaps
   - Adjusting dependency wiring
   - Splitting oversized tickets
   - Adding context to ticket descriptions for self-containment

### Step 3: Iterate (up to 5 rounds)

After revising, invoke the spec-critic again with the updated plan. The critic
reviews fresh -- it does not remember the previous round.

**Cap: 5 rounds maximum.** If the critic still returns REVISE after 5 rounds,
proceed to Phase 5 with the outstanding findings included.

## Phase 5 -- User approval

Present the plan to the user. Include context about the adversarial review:

**If the plan passed cleanly:**

> This plan passed adversarial review. [If medium findings exist: The critic
> noted a few minor items: [summary]. These don't block proceeding.]
>
> [full plan]
>
> Does this plan look right? Say **yes** to create tickets, or tell me what
> to change.

**If the plan passed after revisions:**

> This plan went through N rounds of adversarial review. Key changes from the
> review: [brief summary of what was caught and fixed].
> [If outstanding findings: These items remain as noted tradeoffs: [summary].]
>
> [full plan]
>
> Does this plan look right? Say **yes** to create tickets, or tell me what
> to change.

**If the user requests changes:**

- Revise the plan in place (re-present the full updated plan, not just a diff)
- If the changes are substantial (new tickets, restructured phases, rewritten
  ACs), re-run the spec-critic before re-presenting
- Minor wording tweaks do not need re-review
- Ask for approval again
- Repeat until the user explicitly approves

**Do not create any tickets until the user approves.**

## Phase 6 -- Ticket creation

Once the user approves, create all tickets. Work methodically through the hierarchy,
**capturing every ID immediately** after creation.

### Step 6.1: Top-level epic

Print: `"Creating top-level epic..."`

```bash
TOP=$(tk create "<Feature / Project Name>" -t epic -p 2 -d "<goal sentence from the plan>")
```

### Step 6.2: Phase epics (one per phase, --parent $TOP)

Print: `"Creating phase epics (<N> phases)..."`

```bash
P1=$(tk create "Phase 1: <name> [FOUNDATIONAL]" -t epic -p 2 --parent $TOP -d "<phase objective>")
P2=$(tk create "Phase 2: <name> [SLICES]" -t epic -p 2 --parent $TOP -d "<phase objective>")
P3=$(tk create "Phase 3: <name> [INTEGRATION]" -t epic -p 2 --parent $TOP -d "<phase objective>")
# ... etc for all phases. The bracketed shape tag becomes part of the title so /run-epic-dag
# and humans can see the parallelism intent at a glance.
```

### Step 6.3: Task tickets (children of their phase epic)

Print: `"Creating task tickets..."`

Work through phases in order. Capture each ID. Use heredoc syntax to include the full
description and EARS acceptance criteria -- never truncate to a one-liner.

```bash
# Phase 1
T1_1=$(tk create "<Task 1.1 title>" -t task -p 2 --parent $P1 -d "$(cat <<'EOF'
<Two to three sentence description of the work, enough to implement without reading other
tickets.>

## Files / Produces / Consumes
- **Files**: <paths this task creates or modifies>
- **Produces:** <contracts/artifacts other tasks may consume, or "none">
- **Consumes:** <contracts this reads, naming the producing task or pre-existing surface>

## Acceptance Criteria
- When <trigger>, the system shall <behavior>
- The <component> shall <property>
EOF
)")

T1_2=$(tk create "<Task 1.2 title>" -t task -p 2 --parent $P1 -d "$(cat <<'EOF'
<Description>

## Acceptance Criteria
- When <trigger>, the system shall <behavior>
- If <condition>, the system shall <response>
EOF
)")

# Phase 2
T2_1=$(tk create "<Task 2.1 title>" -t task -p 2 --parent $P2 -d "$(cat <<'EOF'
<Description>

## Acceptance Criteria
- <EARS statement>
EOF
)")

# ... etc
```

### Step 6.4: Dependencies — derive from Files / Produces / Consumes

Print: `"Wiring dependencies from file and contract overlap..."`

Deps are mechanical, not template-based. For each pair of tasks (A, B):

- If A and B share any file in `Files`, sequence them. The order should follow which one
  *defines* the shared surface (usually the foundational one first).
- If B's `Consumes` names something A `Produces`, add `tk dep B A`.
- Otherwise: **no dep**, even if they're "in the same phase."

**FOUNDATIONAL phases** typically chain naturally because each task produces something the
next consumes:
```bash
# Phase 1 (FOUNDATIONAL): T1_2 consumes T1_1's output, T1_3 consumes T1_2's
tk dep $T1_2 $T1_1
tk dep $T1_3 $T1_2
```

**SLICE phases** explicitly do not chain — every slice consumes the same foundational
contract and nothing else:
```bash
# Phase 2 (SLICES): each slice depends on the producing foundational task, NOT siblings
tk dep $T2_1 $T1_3   # slice consumes Phase 1's last foundational output
tk dep $T2_2 $T1_3   # ...as does this one
tk dep $T2_3 $T1_3   # ...and this one
# NO tk dep between T2_1, T2_2, T2_3 — they're independent
```

**INTEGRATION phases** fan in — they depend on the union of producers, not "the last task
of the prior phase":
```bash
# Phase 3 (INTEGRATION): waits on all slices
tk dep $T3_1 $T2_1
tk dep $T3_1 $T2_2
tk dep $T3_1 $T2_3
```

**Forbidden patterns:**
- ❌ `tk dep $T2_1 $T1_<last>` reflexively because "phase 2 comes after phase 1." Look at
  what T2_1 actually consumes. If it consumes T1_2's output, depend on T1_2, not T1_3.
- ❌ Chaining slices to each other. If you find yourself writing `tk dep $T2_2 $T2_1` and
  Task 2.1 doesn't appear in Task 2.2's `Consumes` list, delete the dep.
- ❌ Defaulting to "first task of next phase depends on last task of prior phase." That
  template silently serializes parallelizable work — it's the bug we're trying to avoid.

After all `tk dep` calls, sanity-check the result:

```bash
tk ready --epic <TOP>   # should surface multiple parallel tasks if your plan declared SLICES
```

If a SLICES phase shows only one ready task, you have a stray dep — re-check.

## Phase 7 -- Summary

Print a structured summary of everything created:

```
Spec created: <Feature / Project Name>

  [<TOP>]   <top-level epic title>

  [<P1>]    Phase 1: <name>
    [<T1_1>]  <task title>
    [<T1_2>]  <task title>
    [<T1_3>]  <task title>

  [<P2>]    Phase 2: <name>   (parallel with Phase 3)
    [<T2_1>]  <task title>
    [<T2_2>]  <task title>

  [<P3>]    Phase 3: <name>   (parallel with Phase 2)
    [<T3_1>]  <task title>

  [<P4>]    Phase 4: <name>   (depends on Phase 2 + Phase 3)
    [<T4_1>]  <task title>

  N epics, M tasks created.

To start team execution:             /run-epic <TOP>
To find the first available work:    tk ready
To view the full epic:               tk show <TOP>
To see all phase tickets:            tk epic-status
```

## Edge cases and judgment calls

**Idea is very small** (1 phase, 2-3 tasks): note that a full epic hierarchy may be
overkill, and confirm the user wants it before proceeding.

**Idea is very large** ("rebuild the entire platform"): push back gently --
"This is quite broad. Let's scope Phase 1 to something shippable in 1-2 weeks and spec
the rest later." Then proceed with the scoped version.

**User skips Q&A** ("just make the tickets"): proceed using your best judgment for the
unclear areas, explicitly state every assumption you made, and jump to Phase 3 for the
plan draft. The adversarial review in Phase 4 will catch gaps.

**Backend problem is the unknown**: when the algorithm, model, or output format is genuinely
unclear, suggest a spike ticket as Phase 1 before designing the interface.

**No `tk` installed**: inform the user that this skill requires `tk` and stop.
