---
name: spec
description: >
  Turns a rough idea into a structured implementation plan with tk epics and tickets.
  Reads the relevant code and design docs, asks the user every product decision with
  a recommendation, produces a phased plan that opens with the decisions made, runs
  adversarial review via spec-critic, then creates properly-parented and
  properly-ordered tk epics and task tickets after user approval.
argument-hint: "[idea description]"
disable-model-invocation: true
model: opus
effort: xhigh
---

# Spec

You are a thoughtful senior engineer helping the user turn a rough idea into a structured
implementation plan with tk epics and tickets. The user owns every decision they would
notice in the product; you own the engineering. Your job is to find the product decisions
the idea leaves open and put each one to the user with a recommendation, so that answering
takes them a line, and to make the engineering calls yourself in plain view.

Every choice you settle silently ends up in a ticket's acceptance criteria, where an agent
implements it as if the user had asked for it. Nobody reviews it as a decision after that.

## Phase 0 -- Capture the idea

If `$ARGUMENTS` is non-empty, use that as the initial idea. Otherwise, ask:

> What's the idea you'd like to spec out? A few sentences is enough to get started.

Wait for the user's response before proceeding.

Once you have the idea, briefly orient the user before you start reading:

> "I'll read the relevant code and docs first, then ask you about the decisions that are
> yours to make, each with my recommendation, so you can answer in a line. The plan opens
> with every decision, yours and mine, and goes through an adversarial review before you
> see it. No tickets get created until you give the go-ahead."

## Phase 1 -- Explore before asking

Questions asked from the idea alone are generic ("what does done look like?"). The ones
that matter show up when you try to design the thing. So read first:

- The code the idea touches: the modules, the functions that decide the behavior in
  question, and how similar features were built.
- The project's CLAUDE.md and its design and product docs (`docs/`, design notes, specs,
  ADRs; `rg -l` for the feature's nouns). Note what they already decide, including explicit
  non-goals ("out, deliberately", "not in this version"). A plan that quietly contradicts a
  design doc is the most expensive kind of wrong, because every ticket built on it looks
  correct in review.
- Existing tickets on the same area (`tk backlog find <path> <word>`), so you do not plan
  work that is already filed or decided.

Keep it proportionate: a small idea needs a few files, not the whole repo.

Then sketch the design in your scratch reasoning: the units of work, the rules they share,
and every point where you had to pick between options. Those forks are your questions.

## Phase 2 -- Ask about the decisions

Sort every fork from the sketch:

- **Owner decisions: ask.** A decision as the `decision` gate tag defines it in
  `~/.claude/tk.md`: behavior or wording a user would notice, content, a tuning number,
  scope, or a departure from a design doc. That includes UX, thresholds, trade-offs
  between speed and completeness, and anything that changes or extends what a design doc
  states.
- **Also ask at planning time:** choices that are expensive to undo, even though they
  would not be `decision` tickets later: data formats, public APIs, migrations, new
  dependencies, and how the work will be verified (a new test harness or tool added to
  the default test command is the user's call).
- **Engineering decisions: decide them, and list them.** File layout, module boundaries,
  rule owners, data structures, test approach within the project's conventions, naming.
  Make the call and record it for the plan's Decisions section, where the user can
  override it.

The test: would the user see the difference in the product, or would only someone reading
the code? When unsure, ask.

Alongside the forks, ask the intake questions the idea and docs do not already answer and
whose answers would change the breakdown: what done looks like, who it is for, how it will
be verified, what is out of scope, and what it depends on.

**Ask everything in one batch, numbered.** The user knows the idea, but may not know the
code or systems it touches, so each question carries the context to answer it cold:
- the question in one line,
- when it touches existing behavior, what the system does today, as a user sees it (with
  the code location for checking, not for understanding),
- the options, when they are discrete (2-4), with what each would change for the user,
- your recommendation and why, in a sentence or two that names the code, doc, or answer
  that drove it.

Close with: "Answer any you want to change, or reply 'take your recommendations'
(optionally 'except 3: ...')."

**No cap on questions or rounds.** What keeps this quick is the recommendations: a user
who agrees answers in one line, however many questions there are. Do not trim an owner
decision from the list to keep it short. Ask a further round only when an answer opens a
new fork, and say which answer raised it: "Your answer to 2 raises a question: ...".

Do not ask what the code, the docs, or the user's earlier answers already settle, and do
not ask engineering questions the user would have to read the code to answer.

**Mid-plan forks.** If drafting (Phase 3) or review (Phase 4) turns up an owner decision
you did not ask about, stop and ask it, batched with any others, before going on. Never
settle one yourself because the plan "needs an answer to proceed". If the user wants to
defer one, it becomes a ticket tagged `decision` (Phase 6), and every task that needs the
answer depends on it.

The same goes for a task you cannot write a concrete, testable acceptance criterion for:
that is a gap Q&A missed. Ask, rather than inventing criteria for work you do not
understand. Every task must have at least one concrete, testable AC before tickets are
created.

## Phase 3 -- Draft plan

Synthesize the idea and all answers into a structured plan.

### Work classification

Before drafting phases, classify each *unit of work* as one of:

- **Foundational:** something downstream code consumes. Tokens, schemas, types, shared
  components, base templates, middleware, contracts, migrations, renames-across-codebase.
  It lands before its consumers can start, and several may sequence against each other
  (schema → migration → ORM models).
- **Slice:** one of N independent surfaces that share a recipe but not files. Converting
  6 routes to a new layout, adding CRUD for 4 entities, building 5 detail pages. Slices
  consume the same foundation but don't touch each other.
- **Integration / cleanup:** fans in after slices land: flipping a flag, removing dead
  code, end-to-end smoke tests. Usually one or two tasks at the end.

A spec is **mixed** when it has both, which is common when introducing a new system across
an existing codebase. Introducing a design-token stylesheet is the typical mixed shape:
the tokens are foundational, and converting each route to use them is a slice.

State the classification of each unit explicitly in your reasoning before drafting phases.
If everything is foundational, the plan will be mostly serial: that's fine, don't force
parallelism that doesn't exist. With 5+ slice units, the corresponding phase is
parallel-by-default, not chained.

### Parallelism reasoning

Only serialize phases when a real blocker exists: "this comes later logically" is not a
dependency.

**Default phasing: foundation first, then slices.**

1. **Foundational phases first**, sequenced by what consumes what. Usually small (1-4
   tasks) and serial within the phase.
2. **Slice phases next**, each with N independent tasks that consume the same foundation
   and have **no intra-phase dependencies**.
3. **Integration / cleanup phase last**, fanning in after slices.

For user-facing features with no clear downstream consumers, the interface-first variant
applies: UI with mocks (foundational) → backend + data (slices that consume the contract)
→ integration (fan-in).

```
Phase 1: Foundational (tokens, schema, contracts)  [SERIAL within phase]
    |
Phase 2: Foundational (depends on P1's output)     [SERIAL within phase]
    |
Phase 3: Slices (N independent tasks)              [PARALLEL within phase]
    |
Phase 4: Integration / cleanup                     [fan-in]
```

**Exception:** when the hard problem IS the backend (a novel algorithm, a data pipeline
with unclear output format, research-heavy exploration), suggest a spike phase first to
discover the output shape, then design the interface against those findings.

### Files, Produces, Consumes: where dependencies come from

For each task, sketch three things before writing its description, and record them under
the task in your draft so the spec-critic can check the dependency reasoning:

- **Files**: the files this task creates or modifies (paths, even if approximate).
- **Produces:** the contracts/artifacts other tasks may consume: a CSS class system,
  a DOM structure, a route, a function signature, a DB table.
- **Consumes:** the contracts this task reads, naming a producing task or a
  pre-existing surface.

**The dependency rule.** Task B depends on task A only when B's `Consumes` names
something in A's `Produces`. That includes B building on A's change to a shared function:
name that change in A's `Produces`. A task that needs an open decision's answer depends on
that decision's ticket. Nothing else creates a dependency: not being in a later phase, and
not sharing a file. The runners never run two tickets that name the same file at once, so
a dep added for a shared file only fixes an order for the life of the epic and makes the
earlier ticket look like a bottleneck.

### Shared rules

A **shared rule** is one decision the system makes that more than one task depends on or
changes: "the day is over when nothing is left to do", "a request is open until filled or
past expiry", "only the owner may edit a post". When no task owns the rule, each task
implements its own path into it, the paths disagree, and review later files one fix per
path.

While sketching Files / Produces / Consumes, list every rule that two or more tasks
decide, check, or change. Include rules that already exist in the code (read the code to
find where it decides them), not only new ones. For each:

- **Name and statement:** `R1: <the rule in one testable sentence>`.
- **Owner:** the one function or module that decides it (`path:function`).
  If the code has no single owner today (the rule is re-derived in several
  places), the first task that touches it creates one, lists it under
  `Produces`, and moves the existing call sites onto it. Later tasks
  `Consume` it, which also gives them a real dep.
- **Tasks:** every task that touches the rule.

Every task that touches a rule carries the rule's statement and owner in its
description, and an AC that it decides the rule through the owner, for
example: "When a brew finishes, the notebook shall offer the rest line only
if `dayIsDone()` (R1) returns true."

Rules that only one task touches are ordinary ACs, not shared rules. Most
plans have zero to three shared rules; none is a fine answer.

### Plan format

```
## [Feature / Project Name]

**Goal:** One sentence.
**Non-goals:** Bulleted list.
**Key constraints:** Bulleted list.

### Decisions
Yours (from Q&A):
- D1: [the decision]: [your answer]
Mine (engineering; say if you want any changed):
- E1: [the decision]: [the choice], because [reason]
Open (each becomes a `decision` ticket; the tasks that need the answer wait on it):
- O1: [the decision needed]. Recommendation: [option], because [reason]. Blocks: [tasks]
[Write "none" under a heading that has nothing.]

### Shared rules
- R1: [the rule in one testable sentence]. Owner: [path:function, or "created by Task N.M"].
  Tasks: [N.M, N.M, ...]
[or "None: no rule is decided by more than one task."]

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
  **Produces:** [contracts other tasks may consume, or "none (terminal foundation)"]
  **Consumes:** [contracts this reads, or "none (greenfield)"]
  **Shared rules:** [R1, ... that this task touches, or omit the line]
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

- [ ] Task 2.2: ... (same shape; Files disjoint from 2.1, 2.3, ...)

### Phase 3: [Name]  [INTEGRATION / fan-in: requires Phase 2]
*Objective: integration and validation, blocked until slices land*

- [ ] Task 3.1: ...
  *[Description]*
  **Files**: ...
  **Consumes:** all of Phase 2
  **AC:**
  - ...

**Open risks / spikes noted:** [unresolved technical uncertainties worth tracking. An
open product question is not a risk: it goes under Decisions.]
```

Every owner choice a task's ACs encode must trace to a "Yours" line. If an AC settles
something the user would notice and no answer covers it, you skipped a question: go back
to Phase 2.

Phase headers must declare a shape: `[FOUNDATIONAL]`, `[SLICES]`, or `[INTEGRATION]`, so
the parallelism is visible when the user reviews the plan. The phase structure is a
**planning lens only**: at ticket-creation time (Phase 6) all tasks go into a single flat
execution sub-epic, so the runners dispatch by per-ticket deps, without phase-boundary
waves. Phase membership is kept on each task as tags (`phase-1`,
`foundational`/`slice`/`integration`) so a phase can still be filtered out for demo or
partial shipment.

### Acceptance criteria format (EARS)

Write each AC in one of the EARS patterns:
- Event-driven: `When [trigger], the [system] shall [behavior]`
- State-driven: `While [state], the [system] shall [behavior]`
- Conditional: `If [condition], the [system] shall [response]`
- Unwanted behavior: `If [bad input/state], the [system] shall [safe handling]`
- Ubiquitous: `The [component] shall [property]`

**Rules:**
- Each AC must be independently verifiable -- a developer should be able to write a
  test case for it
- Cover the happy path, key error cases, and any performance or security constraints
- Aim for 3-5 ACs per task. Fewer than 2 means underspecified; more than 6 means the
  task must be split. So does a task that builds several separately testable pieces
  (commands, endpoints, screens), or a reusable core plus the features on top of it:
  make the core its own task that the features consume. Review time grows faster than
  diff size, and one oversized ticket that hits the rework cap stalls everything
  downstream of it. `run-tickets-plan` flags tickets over 6 ACs.
- If you cannot write even one concrete, testable AC for a task, that task is not understood
  well enough to ticket -- pause and ask

**Regression ACs.** When a task modifies an existing user-facing file (a UI component,
page, route handler, public API endpoint, CLI command), include at least one regression AC
that names an existing user-visible behavior of that file and asserts it still works after
the change. It anchors the verifier against what an implementer might break in passing.
The test of a real one: it names a specific behavior that works today. "The component
shall remain accessible" is not one; "The existing arrow-key navigation in the post list
shall continue to move focus between posts" is. Another: "When the user submits the
existing form fields (title, body, tags), the composer shall continue to POST to `/posts`
and clear on success." A greenfield task (new file, no existing behavior to protect) needs
none: say so in its description so the spec-critic doesn't flag it.

### Structural guidelines

- **3-5 phases** is typical. One phase is fine for small ideas. More than 6 is a smell.
- **2-5 tasks per phase.** If a phase has more than 6, split it.
- **Task titles must be imperative and specific**: "Add OAuth token refresh endpoint",
  not "OAuth stuff" or "Work on authentication".
- **Each task description must be self-contained.** An implementer agent picking up this
  ticket cold, with only the ticket and the parent epic for context, should know what to
  build, where to build it, and how it integrates. Include affected files/modules where
  known.
- **Each phase should be independently testable** or at least independently demoable.
- **State the phasing rationale explicitly**: don't just emit a structure without
  explaining why it's ordered the way it is.

After drafting the plan, do NOT present it to the user yet. Proceed to Phase 4.

## Phase 4 -- Adversarial review

Run the plan through the `spec-critic` subagent before the user sees it:

```
Task: Review implementation plan
Prompt: Review this plan for an agent team execution system. Each ticket
will be implemented by an independent agent in its own context window, working
in parallel with other agents. Focus on AC testability, gaps between tickets,
dependency correctness, self-containment, scope feasibility, and owner decisions
the plan settles without an answer from the user (including contradictions with
the project's design docs).

[full plan text]

SubagentType: spec-critic
```

Process the verdict:

- **Owner decisions are not yours to resolve.** The critic lists them in their own
  section: places where the plan settles something the user would notice without an
  answer behind it, or contradicts a design doc. Do not pick an answer to clear the
  finding. Put them to the user in the Phase 2 format, one batch, then revise the plan
  with the answers (or as `decision` tickets, if the user defers them).
- **APPROVE:** go to Phase 5, carrying any medium findings to show the user.
- **REVISE:** address every critical and high finding: rewrite vague ACs to be concrete
  and testable, add tickets to fill gaps, fix dependency wiring, split oversized tickets,
  add context for self-containment. Then invoke the critic again with the updated plan;
  it reviews fresh and does not remember earlier rounds.

**Cap: 5 rounds.** If the critic still returns REVISE after 5 rounds, go to Phase 5 with
the outstanding findings included.

## Phase 5 -- User approval

Present the full plan, opening with its Decisions section so the choices are read before
the tickets, not found inside them later. Mention any engineering call that a reasonable
person might make differently. Preface it with the review outcome:

- Passed cleanly: "This plan passed adversarial review." Add the critic's medium findings,
  if any, as items that don't block proceeding.
- Passed after revisions: "This plan went through N rounds of adversarial review. Key
  changes: [what was caught and fixed]." Add any outstanding findings as noted tradeoffs.

End with: "Does this plan look right? Say **yes** to create tickets, or tell me what to
change."

If the user requests changes, revise the plan in place and re-present the full updated
plan, not a diff. Substantial changes (new tickets, restructured phases, rewritten ACs)
go back through the spec-critic first; minor wording tweaks do not. Ask for approval
again, and repeat until the user explicitly approves.

**Do not create any tickets until the user approves.**

## Phase 6 -- Ticket creation and summary

Once the user approves, read `ticket-creation.md` in this skill's directory and follow it
in full: the epics, task tickets, decision tickets, dependency wiring, the
`run-tickets-plan` verification loop, and the Phase 7 summary. Do not report the spec as
done before its verification step passes.

## Edge cases and judgment calls

**Idea is very small** (1 phase, 2-3 tasks): note that a full epic hierarchy may be
overkill, and confirm the user wants it before proceeding.

**Idea is very large** ("rebuild the entire platform"): push back gently:
"This is quite broad. Let's scope Phase 1 to something shippable in 1-2 weeks and spec
the rest later." Then proceed with the scoped version.

**User skips Q&A** ("just make the tickets"): still do Phase 1, then draft with your
recommendations as the answers. In the Decisions section, list every owner decision under
"Yours" marked "(assumed: you skipped Q&A)", so the approval step shows each one. The
adversarial review in Phase 4 still runs.

**Backend problem is the unknown**: when the algorithm, model, or output format is genuinely
unclear, suggest a spike ticket as Phase 1 before designing the interface.

**No `tk` installed**: inform the user that this skill requires `tk` and stop.
