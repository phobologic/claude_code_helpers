# Spec: ticket creation (Phase 6) and summary (Phase 7)

Read this once the user has approved the plan. It turns the approved plan into `tk`
tickets: a top-level epic for the planning view, one flat execution sub-epic, every task
as a child of that sub-epic (tagged with its phase and shape), a `decision` ticket for
each open decision, and dependencies wired only from Produces/Consumes. Then it checks
that `run-tickets-plan` can read every ticket and prints the summary. Do not report the
spec as done until Step 6.5 passes.

## Contents
- Step 6.1: Top-level epic
- Step 6.2: Execution sub-epic
- Step 6.3: Task tickets (description template, headings the planner parses)
- Step 6.3b: Decision tickets
- Step 6.4: Dependencies from Produces / Consumes
- Step 6.5: Verify the runner can read every ticket
- Phase 7: Summary

The hierarchy is **flat for execution**: phase membership lives on each task as tags, not
as sub-epic boundaries, so the runners dispatch by per-ticket deps without phase-boundary
waves. Capture every ID immediately after creation.

## Step 6.1: Top-level epic

```bash
TOP=$(tk create "<Feature / Project Name>" -t epic -p 2 -d "<goal sentence from the plan>")
```

## Step 6.2: Execution sub-epic (flat container)

```bash
EXEC=$(tk create "<Feature / Project Name> -- execution (flat DAG)" \
  -t epic -p 2 --parent $TOP -d "Flat container for all leaf tickets, so the runners dispatch them by per-ticket deps without phase-boundary waves. See parent $TOP for the phased planning view. Each task is tagged with its phase (phase-1, phase-2, ...) and shape (foundational/slice/integration) for optional filtering.")
```

## Step 6.3: Task tickets (all children of $EXEC, tagged with phase + shape)

Work through phases in order so titles and IDs come out in a sensible sequence. **All
tasks parent to `$EXEC`**, not to per-phase epics. Each task gets two tags:

- `phase-N`: the planning phase it came from (`phase-1`, `phase-2`, ...)
- shape: one of `foundational`, `slice`, `integration`

Keep the `N.M` numbering in titles so phase grouping is visible at a glance. Write
each full description to a file and pass it with `-d "$(cat <file>)"`. Never
truncate to a one-liner. Do not nest a heredoc inside `$(...)` instead: macOS bash
3.2 fails on any apostrophe in the body there, even with a quoted `'EOF'`.

For each task, first `Write` its description to `.tmp/spec-<task>-<unique>.md`
(the `<unique>` suffix as for commit messages), for example:

```markdown
<Two to three sentence description of the work, enough to implement without reading other
tickets.>

## Files / Produces / Consumes
- **Files**: <paths this task creates or modifies>
- **Produces:** <contracts/artifacts other tasks may consume, or "none">
- **Consumes:** <contracts this reads, naming the producing task or pre-existing surface>

## Shared rules
<Only if the task touches one. For each: "R1: <statement>. Owner: <path:function>.
Check or change it only through the owner; do not re-derive it here." Omit the section otherwise.>

## Acceptance Criteria
- When <trigger>, the system shall <behavior>
- The <component> shall <property>
```

**Use these headings verbatim.** `run-tickets-plan` parses them: it detects ACs by an
`Acceptance Criteria` heading (or `**Acceptance Criteria**` / `Acceptance criteria:`) and
reads the file list from a line starting `**Files**:` (colon outside the bold). A ticket
whose ACs sit under any other label, such as the plan draft's `**AC:**`, is treated as
having no ACs and skips AC verification; a `**Files:**` line (colon inside the bold) yields
no files and disables overlap detection. Never generate ticket bodies by copying task
blocks out of the Phase 3 plan; rewrite each into this template. Step 6.5 checks the result.

Then create the ticket from it and delete the file:

```bash
# Phase 1 tasks (FOUNDATIONAL)
T1_1=$(tk create "1.1 <Task title>" -t task -p 2 --parent $EXEC \
  --tags phase-1,foundational -d "$(cat .tmp/spec-1.1-a3f9c1.md)") && rm -f .tmp/spec-1.1-a3f9c1.md

T1_2=$(tk create "1.2 <Task title>" -t task -p 2 --parent $EXEC \
  --tags phase-1,foundational -d "$(cat .tmp/spec-1.2-a3f9c1.md)") && rm -f .tmp/spec-1.2-a3f9c1.md

# Phase 2 tasks (SLICES)
T2_1=$(tk create "2.1 <Task title>" -t task -p 2 --parent $EXEC \
  --tags phase-2,slice -d "$(cat .tmp/spec-2.1-a3f9c1.md)") && rm -f .tmp/spec-2.1-a3f9c1.md

# ... etc. Integration tasks get --tags phase-N,integration
```

## Step 6.3b: Decision tickets

For each "Open" decision in the plan, create a ticket the runners will not hand to an
agent until the user answers it:

```bash
O1=$(tk create "Decide: <the decision needed>" -t task -p 2 --parent $EXEC \
  --tags decision -d "$(cat .tmp/spec-O1-a3f9c1.md)") && rm -f .tmp/spec-O1-a3f9c1.md
```

The description (written to the file first, as in 6.3) gives the context, the options,
your recommendation and why, and the tasks that wait on the answer. Then
`tk dep <task> $O1` for each of those tasks. Write those tasks' acceptance criteria
for your recommended option, and say so in each description ("Criteria assume O1 =
<recommendation>"), so whoever records a different answer knows to restate them.
`/run-tickets` asks the user about it before dispatch; on an answer it closes the ticket
and passes the answer to the waiting tasks. The user can also note the answer on the
ticket and close it by hand.

## Step 6.4: Dependencies from Produces / Consumes

Deps are mechanical. For each pair of tasks (A, B):

- If B's `Consumes` names something A `Produces`, add `tk dep B A`.
- If B needs an open decision's answer, add `tk dep B <decision ticket>` (6.3b).
- Otherwise: **no dep**, even in the same phase, and even if they share a file.

**FOUNDATIONAL** phases usually chain, because each task consumes the previous one's
output:
```bash
tk dep $T1_2 $T1_1
tk dep $T1_3 $T1_2
```

**SLICE** phases do not chain: each slice depends on the foundational task it consumes,
never on a sibling:
```bash
tk dep $T2_1 $T1_3
tk dep $T2_2 $T1_3
tk dep $T2_3 $T1_3
# no tk dep between T2_1, T2_2, T2_3
```

**INTEGRATION** phases fan in on the union of what they consume:
```bash
tk dep $T3_1 $T2_1
tk dep $T3_1 $T2_2
tk dep $T3_1 $T2_3
```

**Forbidden patterns:**
- ❌ `tk dep $T2_1 $T1_<last>` reflexively because "phase 2 comes after phase 1." If T2_1
  consumes T1_2's output, depend on T1_2, not T1_3.
- ❌ Chaining slices to each other. If you write `tk dep $T2_2 $T2_1` and Task 2.1 is not
  in Task 2.2's `Consumes`, delete the dep.
- ❌ "First task of the next phase depends on the last task of the prior phase" as a
  template. It silently serializes parallel work.
- ❌ A dep whose only reason is a shared file. Delete it unless B's `Consumes` names A.

Then sanity-check:

```bash
tk ready   # should surface multiple parallel tasks if the plan declared SLICES
```

If a SLICES phase shows only one ready task (filter with `tk triage --tag phase-2` or
similar), you have a stray dep: re-check.

## Step 6.5: Verify the runner can read every ticket

Run the same planner `/run-tickets` uses and check every task:

```bash
run-tickets-plan $EXEC | jq -r '.tickets[] | "\(.id) has_ac=\(.has_ac) files=\(.files | length) \(.title)"'
run-tickets-plan $EXEC | jq -r '.excluded[]?'
```

Every task must show `has_ac=true` and `files` greater than 0, and nothing may be
excluded except the `decision` tickets and the tasks waiting on them (the planner lists
those under `decisions`). If any ticket fails, fix its description (usually a heading that
does not match the Step 6.3 template) and re-run this check. Do not print the Phase 7
summary or report the spec as done until every task passes. If `run-tickets-plan` is not
installed, say so and fall back to checking each ticket file for a `## Acceptance Criteria`
heading and a `**Files**:` line.

## Phase 7: Summary

Print a structured summary of everything created:

```
Spec created: <Feature / Project Name>

  [<TOP>]   <top-level epic title>            (planning view)
    [<EXEC>]  <name> -- execution (flat DAG)  (run this)

  Tasks (all parented to <EXEC>, grouped by phase tag for readability):

  phase-1 / foundational
    [<T1_1>]  1.1 <task title>
    [<T1_2>]  1.2 <task title>
    [<T1_3>]  1.3 <task title>

  phase-2 / slice   (parallel with phase-3)
    [<T2_1>]  2.1 <task title>
    [<T2_2>]  2.2 <task title>

  phase-3 / slice   (parallel with phase-2)
    [<T3_1>]  3.1 <task title>

  phase-4 / integration   (fan-in after phase-2 + phase-3)
    [<T4_1>]  4.1 <task title>

  Waiting on your decision (tagged decision; runners skip these and what depends on them):
    [<O1>]  Decide: <decision needed>   blocks <task ids>

  2 epics, M tasks created.

To start execution:                  /run-tickets <EXEC>
To ship it when the run is done:     /wrap-epic <EXEC>   (closes <TOP> too once nothing is left in it)
To find the first available work:    tk ready
To view the planning epic:           tk show <TOP>
To view the execution epic:          tk show <EXEC>
To filter by phase (e.g. demo P2):   tk triage --tag phase-2
```
