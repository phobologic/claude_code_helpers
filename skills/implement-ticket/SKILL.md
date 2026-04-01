---
name: implement-ticket
description: Implement one or more tk tickets. Use when the user says "implement ticket X", "work on ticket", "do ticket #N", "tackle the next ticket", or similar.
argument-hint: "[id ...] [-- extra instructions]"
---

# Implement Ticket

## Phase 0 — Argument parsing

Parse `$ARGUMENTS`:
- Ticket IDs are space-separated tokens before any `--`
- Everything after `--` is extra instructions that inform the design phase
- Examples:
  - `/implement-ticket 42` — single ticket
  - `/implement-ticket 42 43` — process both, sequentially
  - `/implement-ticket 42 -- focus on error handling, skip migration` — ticket with constraints

## Phase 1 — Ticket selection

**If ticket IDs were provided**: run `tk show-multi <ids>` to load full context.

**If any loaded ticket has `type == "epic"`**:
1. Run `tk query '.parent == "<epic-id>"'` to find its child tickets
2. Filter to only eligible children (status is not `closed` or `in-progress`)
3. If no eligible children remain, inform the user the epic is fully complete or all work is in-progress, and stop
4. Present suggested next tickets with reasoning (same UX as the no-args path: 2–3 picks + full list)
5. Ask the user which child ticket(s) to proceed with
6. Continue the rest of the skill with those child IDs — never implement the epic itself

**If no IDs provided**:
1. Run `tk ready` to get unblocked work
2. Read each ticket's description to understand scope and context
3. Present two things to the user:
   - **Suggested next tickets** (2–3 picks with reasoning — e.g., "unblocks the most
     downstream work", "highest priority", "quickest win based on scope")
   - **Full ready list** for their reference
4. Ask the user which ticket(s) to proceed with

## Phase 2 — Complexity triage

Read the selected ticket(s) and parent epic (if set). Make a judgment call:

**Straightforward** — typo, config change, single clear action with no design ambiguity:
- Describe what you'll do in 1–2 sentences
- Ask the user for a quick go-ahead
- Skip Phases 3–4 and proceed directly to implementation

**Complex** — new feature, tricky bug, or non-obvious design decisions:
- Proceed through the full design and planning flow below

## Phase 3 — Requirements clarification + acceptance criteria

Before writing any plan, fully understand what "done" looks like.

### 3a — Gather context

1. If the ticket has a parent epic, run `tk show <epic-id>` and
   `tk query '.parent == "<epic-id>"'` to scan sibling tickets — look for decisions already
   made, patterns established, or constraints documented in their notes
2. Scan the affected code area with Glob and Grep to understand existing patterns
3. Check for reusable utilities — avoid reinventing what already exists
4. Incorporate any extra instructions from Phase 0 as constraints

### 3b — Clarifying questions

Identify all open questions: ambiguous requirements, approach tradeoffs, missing context,
constraints from CLAUDE.md or the parent epic.

Ask **no more than 3 at a time**, grouped logically. If you have more than 3, ask the
first group, wait for answers, then ask the next group. Continue until all questions are
resolved. Do not proceed to 3c until the requirements are unambiguous.

### 3c — Decision persistence

As decisions are reached through 3b, categorize and record them immediately:

- **Ticket-scoped** (how to implement this specific thing):
  captured in the acceptance criteria note written in step 3d
- **Epic-scoped** (design choices that will affect sibling tickets):
  `tk add-note <epic-id> "Decision: <what was decided and why>"`
- **Project-wide** (conventions that should always apply going forward):
  append to `CLAUDE.local.md` with a brief rationale

### 3d — Write acceptance criteria

Once questions are resolved, write a `tk add-note` that records what "done" looks like.
Use EARS (Easy Approach to Requirements Syntax) for each criterion:

| Pattern | Template | Use when |
|---|---|---|
| Event-driven | `When [trigger], the [system] shall [behavior]` | User actions, API calls, async events |
| State-driven | `While [state], the [system] shall [behavior]` | Modes, ongoing conditions |
| Conditional | `If [condition], the [system] shall [response]` | Error cases, optional features |
| Unwanted behavior | `If [bad input/state], the [system] shall [safe handling]` | Validation, error handling |
| Ubiquitous | `The [component] shall [property]` | Always-true constraints, invariants |

**Rules:**
- Each criterion must be independently verifiable — a developer should be able to write a
  test for it
- Cover the happy path, key error cases, and any relevant constraints
- Aim for 2–4 criteria. Fewer means underspecified; more means the ticket should be split
- If you cannot write even one concrete, testable criterion, you don't understand the
  ticket well enough yet — go back to 3b

```
tk add-note <id> "ACCEPTANCE CRITERIA:
- When [trigger], the [system] shall [behavior]
- If [condition], the [system] shall [response]
- The [component] shall [property]

Decisions: <any ticket-scoped design decisions reached in this phase>"
```

This note is the contract between implementation and verification. Be specific — vague
criteria make the verification phase impossible.

## Phase 4 — Plan + approval (complex only)

Present a full implementation plan:
- Files to create or modify
- Key decisions made in Phase 3
- Test strategy (what to test, how)
- Schema or migration changes if applicable

Wait for explicit user approval before writing any code.

## Phase 5 — Implementation

Run `tk start <id>` to claim the ticket, then implement according to the approved plan.

## Phase 6 — Tests

1. Run tests scoped to the changed area first (faster feedback)
2. Run the full test suite
3. Fix any failures before continuing — do not proceed with a broken suite

## Phase 7 — Self-review

Before verifying completion, use the Skill tool to invoke the `review` skill — call
`Skill(skill="review")` exactly. This is the single-agent adversarial review (one
`code-critic` agent). Do NOT invoke `multi-review`, and do NOT launch reviewer agents
(code-reviewer-1, code-reviewer-2, etc.) directly. Let the skill handle everything.
Read its output and triage findings:

- **Critical issues found**: present them to the user, fix them, then repeat Phase 7 until the review is clean
- **High issues found**: present them to the user and ask — fix now, or create a ticket and proceed?
- **Medium findings**: the review skill will auto-create tk tickets; note the ticket IDs for Phase 9
- **No Critical or High issues**: proceed to Phase 8

## Phase 8 — Verification loop

Spawn a verifier agent using the Agent tool. Provide it with the following prompt:

> You are a requirements verifier. Your job is to determine whether the current
> implementation satisfies the acceptance criteria for ticket `<id>`.
>
> Steps:
> 1. Run `tk show <id>` to read the ticket and find the ACCEPTANCE CRITERIA note written
>    during requirements clarification. If no such note exists, return:
>    `FAIL: No acceptance criteria note found on ticket <id>.`
> 2. Run `git diff` and `git diff --cached` to see all current changes.
> 3. Compare the changes against each criterion in the ACCEPTANCE CRITERIA note.
> 4. Return one of:
>    - `PASS` — every criterion is met by the current changes
>    - `FAIL` — followed by a numbered list of specific unmet criteria, with a brief
>      explanation of what is missing or incorrect for each

**On FAIL:** address each gap listed by the verifier. Re-run tests (Phase 6) if the fixes
are non-trivial. Then loop back to Phase 8 — spawn a fresh verifier.

**On PASS:** proceed to Phase 9.

## Phase 9 — Commit + close

1. Stage relevant files and commit with a message that references the ticket ID
2. `tk add-note <id> "..."` — record design decisions made in Phase 3, approaches
   considered, any gotchas encountered, and any review ticket IDs created in Phase 7
3. `tk close <id>`
4. Run `git status` and confirm it's clean

## Multiple tickets

If multiple ticket IDs were provided, process them one at a time in the order given.
Complete all phases for each ticket before starting the next.
