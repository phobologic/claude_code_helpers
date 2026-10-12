---
name: review
description: >
  Review code with Claude Code's built-in /code-review, then file every finding as a
  tk ticket under a new review epic, deduplicated against open tickets, so
  /run-tickets can work them. Takes /code-review's level and target. Use only when
  the user types /review.
argument-hint: "[low|medium|high|xhigh|max] [PR number | branch | path ...] [--max-findings <n>|all]"
disable-model-invocation: true
model: opus
---

# Review and file

`/code-review` finds the bugs. This skill turns its findings into `tk` tickets. Do
not review the code yourself, and do not drop or soften a finding because you
disagree with it: file it, and say what you doubt in the ticket.

If `tk` is not installed (`command -v tk` fails), tell the user to run
`/code-review` directly, since there is nothing to file into, and stop.

## Step 1: Read the arguments

From `$ARGUMENTS`:

- **Level**: a leading `low`, `medium`, `high`, `xhigh` or `max`. Default `high`.
  Always pass a level: with none, `/code-review` reuses whatever level the user
  typed last, and the cost of `/review` should not depend on that.
- **`ultra`**: stop. It is a billed cloud review that only the user can launch.
  Tell them to run `/code-review ultra ...` themselves, and that its findings
  will not be filed.
- **`--fix`, `--comment`, `--post`**: stop and tell the user to run
  `/code-review` directly for those. `/review` files findings; it does not apply
  or post them.
- **`--max-findings <n|all>`**: pass it through. Default `--max-findings all`:
  the level already sets how sure a finding must be, and a count cap would drop
  findings that should be tickets without saying so.
- **Target**: everything else, passed through unchanged. With none,
  `/code-review` reviews the current branch's diff plus uncommitted changes.
  It also takes a PR number, a branch, or paths. Commit ranges ("last 3
  commits", "since abc123") are not a documented target: pass them through, and
  in the summary say what the review reports it covered.

Note the reviewed commit and branch for the epic:
`git rev-parse --short HEAD` and `git branch --show-current`.

**Target kind** decides where findings go in Step 4:
- **Diff** (no target, a PR, a branch): findings are `new` or `preexisting`.
- **Paths**: the user asked for that code to be reviewed, so every finding is
  `requested` and goes in the review epic.

## Step 2: Run /code-review

Invoke the `code-review` skill with the Skill tool, args
`<level> <target> --max-findings <n|all>`.

It runs as a background agent, so the call returns only its name. End your
turn there; its result arrives later as a task notification, and you continue
from Step 3. Do not poll, and do not file anything before it arrives. If the
Skill call returns the findings directly instead, go on with those.

The result is a short summary followed by a JSON array of findings, each with
`file`, `line`, `summary` and `failure_scenario`, and sometimes `category` and
`verdict`. If the agent failed or was stopped, say so and stop. If it found
nothing, say so and stop without creating an epic.

## Step 3: Triage each finding

Read the cited code when you need it to judge a finding, but do not go looking
for new ones. For each finding, decide:

1. **Merge.** `/code-review` merges only near-identical findings. Merge further
   when one fix covers several findings: the same defect at several sites, or
   the same bug class fixed by one change (one regex, one list, one guard). The
   test is that fixing one would fix the other. One ticket, every location on
   its `**Files**` line. Findings that need separate fixes stay separate, even
   in the same function.
2. **Priority**, meaning how bad it is if real, from the failure scenario:
   - **0 Critical**: data loss, security breach, crash, broken core contract
   - **1 High**: likely bug, significant security weakness, serious performance
     regression
   - **2 Medium**: reliability risk, test gap, smell, convention violation
   - **3 Low**: nit

   Priority is impact times realistic exposure, not the size of the fix.
   Cleanup, simplification and conventions findings are medium or low.
3. **Origin.** For a diff target, `new` when the finding sits on a line the
   diff added or changed, or that the diff breaks; otherwise `preexisting`. For
   a paths target, `requested`.
4. **Decision.** If the right fix is a choice the owner would notice in the
   product (behavior, wording, content, a tuning number, scope, or a departure
   from a design doc) and nothing in the code or docs settles it, tag it
   `decision`. Put the decision needed, the options and your recommendation in
   the description. `/run-tickets` asks the owner before any agent implements
   it; without the tag, the next run implements your recommendation as if it
   had been approved.
5. **Already ticketed?** Run `tk backlog find <file name> <function or symbol>`
   from the repo root. If an open ticket's fix would also fix this finding, add a
   note to it instead of filing:
   `tk add-note <id> "Seen again by /review (<level>, <sha>): <file>:<line>: <one-line summary>"`.
   If an open ticket is related but its fix would not cover this one, file a new
   ticket and name the related one in its description.

## Step 4: File

Run every `tk` command from the repo root: tk derives new ids from the current
directory name.

Create the epic once you know at least one ticket goes in it:

```bash
EPIC_ID=$(tk create "Review: <what was reviewed> (<YYYY-MM-DD HH:MM>)" -t epic -p 2 --tags code-review -d "/code-review <level> <target> at <sha> on <branch>")
```

Where each ticket goes:
- `new` and `requested`: the review epic.
- `preexisting` at priority 0 or 1: the review epic.
- `preexisting` at priority 2 or 3: the repo's backlog epic,
  `--parent $(tk backlog ensure)`, with the extra tag `preexisting`.

Write each description to `.tmp/review-finding-<6 random hex>.md` with the
`Write` tool, then create the ticket and delete the file in one step:

```bash
tk create "<concise title>" -p <0-3> --parent <parent> --tags code-review[,preexisting][,decision] -d "$(cat .tmp/review-finding-<hex>.md)" && rm -f .tmp/review-finding-<hex>.md
```

```
**Files**: <path>:<line>[, <path>:<line> ...]
**Origin**: <new: the diff line that introduced it | preexisting | requested>
**Description**: <what is wrong and why it matters, in plain words>
**Failure scenario**: <the reported failure scenario>
**Suggested Fix**: <only when the finding names one or the cited code makes it plain; otherwise leave this line out>
**Decision**: <decision tickets only: the decision needed, the options, your recommendation>
**Acceptance Criteria**:
- WHEN <the failure scenario's trigger> THEN <the correct behavior>
- A regression test exercises <that case>
**Source**: /code-review <level> at <sha>[, verdict <verdict>]
```

Keep `**Files**:` lines to paths and line numbers: `/run-tickets` reads them to
tell which tickets touch the same file. Every ticket gets acceptance criteria,
lows included, so `/run-tickets` can verify the fix. For a `decision` ticket,
write them for your recommended option.

## Step 5: Summary

```
## Review: <target or "current branch">

/code-review <level> at <sha>: <N> findings, filed as <T> tickets in <EPIC_ID>,
<B> in the backlog (<backlog id>), <K> noted on existing tickets, <M> merged
into other tickets.

### P0
- <id> <title> (<file>:<line>)
### P1
...
Backlog: <id> <title>, one per line
Noted on existing tickets: <id>: <finding>, one per line
Decisions for you: <id>: <the decision needed>, one per line, or "none"
```

Then the next steps:

- `tk triage --epic <EPIC_ID> --sort priority,created` to read the tickets
- `/run-tickets <EPIC_ID>` to fix them; it asks about `decision` tickets first
