---
name: multi-review
description: Perform a comprehensive code review using multiple specialized sub-agents in parallel. Covers logical correctness, performance, readability, and security. Creates tk tickets if tk is available, otherwise writes a report to .code-review/final-report.md.
disable-model-invocation: true
---

# Multiple Code Reviewers

You are the **team lead** for a parallel code review. Your job is to orchestrate four specialized reviewer agents, receive their findings, deduplicate, and create tickets (or write a report). You never review code yourself — that's the reviewers' job.

## Step 1: Setup and collect context

Parse `$ARGUMENTS` to determine scope, then run the setup script in a **single Bash call**:

- **No arguments** (default — uncommitted changes): `review-setup`
- **Commit references** (e.g., "last 3 commits", "since abc123", "HEAD~5"): Determine the appropriate base ref from the user's intent, then `review-setup --scope commit-range --base-ref <ref>`
- **Specific files** (e.g., "Review src/auth.py src/models.py"): `review-setup --scope files --files src/auth.py src/models.py`

Capture `TK_AVAILABLE`, `REVIEW_CMD`, and `FILES_COUNT` from the output.

If `FILES_COUNT` is 0, tell the user there are no files to review and stop.

## Step 2: Create the epic (if TK_AVAILABLE)

If `TK_AVAILABLE` is true:

1. Examine the changed files list and generate a short, descriptive title summarizing what's being reviewed (e.g., "Review: Auth module refactor" or "Review: API endpoint updates and test fixes").
2. Create an epic with a timestamp for uniqueness:
```bash
EPIC_ID=$(tk create "<generated title> (<YYYY-MM-DD HH:MM>)" -t epic -p 2 --tags code-review -d "<brief summary of changes being reviewed>")
```
3. Note the `EPIC_ID` — you'll use it to create tickets during the coordination loop.

## Step 3: Create the team

```
TeamCreate({
  team_name: "review-<YYYYMMDD-HHMM>",
  description: "Code review team"
})
```

Note the `team_name` — pass it to every Agent call.

## Step 4: Spawn reviewers

Spawn all four reviewers in parallel as **background agents**. Each agent receives `TEAM_MODE=true` and `REVIEW_CMD=<review_cmd>` in its prompt.

```
Agent({
  prompt: "TEAM_MODE=true REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt",
  subagent_type: "code-reviewer-1",
  model: "sonnet",
  team_name: "<team_name>",
  name: "reviewer-logic",
  run_in_background: true
})

Agent({
  prompt: "TEAM_MODE=true REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt",
  subagent_type: "code-reviewer-2",
  model: "sonnet",
  team_name: "<team_name>",
  name: "reviewer-perf",
  run_in_background: true
})

Agent({
  prompt: "TEAM_MODE=true REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt",
  subagent_type: "code-reviewer-3",
  model: "sonnet",
  team_name: "<team_name>",
  name: "reviewer-structure",
  run_in_background: true
})

Agent({
  prompt: "TEAM_MODE=true REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt",
  subagent_type: "security-reviewer",
  model: "sonnet",
  team_name: "<team_name>",
  name: "reviewer-security",
  run_in_background: true
})
```

## Step 5: Coordination loop

This is your main loop. Track how many DONE messages you've received (target: 4). In file mode, accumulate findings in an in-memory list.

### When you receive a finding from any reviewer:

Findings arrive as plain-text messages starting with `FINDING`. Parse the `key: value` lines to extract: `title`, `file`, `lines`, `description`, `fix`, `priority`, `confidence`, `reviewer`. (If a reviewer still emits `severity:`, treat it as a synonym for `priority:`.)

**Check for duplicates before acting:**

- **TK mode**: Query existing tickets under the epic:
  ```bash
  tk query '.[] | select(.parent=="<epic_id>")'
  ```
  Two findings are duplicates if they reference the same `file`, overlapping `lines`, and describe the same core problem.

- **File mode**: Compare against your in-memory list of accumulated findings.

**If it's a new finding:**

- **TK mode**: Create a ticket:
  ```bash
  tk create "<title>" \
    --parent <EPIC_ID> \
    -p <priority> \
    --tags "code-review,reviewer:<reviewer>" \
    -d "**File**: <file>:<lines>
  **Description**: <description>
  **Suggested Fix**: <fix>
  **Confidence**: <confidence>"
  ```
  Priority mapping: `critical` → `-p 0`, `high` → `-p 1`, `medium` → `-p 2`, `low` → `-p 3`

- **File mode**: Append to your in-memory findings list.

**If it duplicates an existing finding:**

- **TK mode**:
  ```bash
  tk add-note <existing-id> "Also reported by reviewer:<reviewer> — <description>"
  ```
- **File mode**: Note the duplicate reviewer in your in-memory list entry.

Acknowledge the finding back to the reviewer with a brief SendMessage (one line is fine).

### When you receive `DONE` from a reviewer:

Note it. When all 4 reviewers have sent `DONE`, proceed to Step 6.

## Step 6: Cleanup and summary

### Shut down the team

```
TeamDelete({ team_name: "<team_name>" })
```

### TK mode — present summary

```bash
tk query '.[] | select(.parent=="<epic_id>")'
```

Present an inline summary:

```
## Code Review Summary

Epic: <epic_id>

### Overview
Analyzed X files. Found:
- N P0 (Critical) issues
- N P1 (High) issues
- N P2 (Medium) issues
- N P3 (Low) issues
- N duplicates merged

### P0 - Critical Issues
- **<tk-id>** [reviewer:<label>] <title> — <file>:<lines>

### P1 - High Priority Issues
- **<tk-id>** [reviewer:<label>] <title> — <file>:<lines>

### P2 - Medium Priority Issues
- **<tk-id>** [reviewer:<label>] <title> — <file>:<lines>

### P3 - Low Priority Issues
- **<tk-id>** [reviewer:<label>] <title> — <file>:<lines>
```

Tell the user they can browse tickets with:
- `tk show <id>` — view a specific ticket
- `tk triage --epic <epic_id> --sort priority,confidence` — walk findings highest-priority-first, then highest-confidence within each band (the canonical way to review produced findings)
- `tk query '.[] | select(.parent=="<epic_id>")'` — raw list of review tickets

Findings carry a priority (Critical/High/Medium/Low → `-p 0..3`) and an
epistemic confidence score (0–100) — see the reviewer agents for the rubric.

### File mode — write and present report

Organize accumulated findings by priority (critical → high → medium → low). Deduplicate anything that slipped through. Write to `.code-review/final-report.md` using this format:

```markdown
# Code Review Summary

## Overview
Analyzed X files. Found N issues across Y reviewers.

## Critical Issues
### <Title>
- **Reviewer**: <reviewer>
- **File**: <file>:<lines>
- **Description**: <description>
- **Suggested Fix**: <fix>
- **Confidence**: <score>

## High Priority Issues
...
```

Then present the report to the user.
