---
name: multi-review
description: Perform a comprehensive code review using multiple specialized sub-agents in parallel. Covers logical correctness, performance, readability, and security. Creates tk tickets if tk is available, otherwise writes a report to .code-review/final-report.md.
disable-model-invocation: true
---

# Multiple Code Reviewers

This command performs a comprehensive code review using specialized sub-agents.

## Step 1: Setup and collect context

Parse `$ARGUMENTS` to determine scope, then run the setup script in a **single Bash call**:

- **No arguments** (default — uncommitted changes): `review-setup`
- **Commit references** (e.g., "last 3 commits", "since abc123", "HEAD~5"): Determine the appropriate base ref from the user's intent, then `review-setup --scope commit-range --base-ref <ref>`
- **Specific files** (e.g., "Review src/auth.py src/models.py"): `review-setup --scope files --files src/auth.py src/models.py`

Capture `TK_AVAILABLE`, `REVIEW_CMD`, and `FILES_COUNT` from the output.

If `FILES_COUNT` is 0, tell the user there are no files to review and stop.

## Step 2: tk mode setup (if TK_AVAILABLE)

If `TK_AVAILABLE` is true:

1. Examine the changed files list and generate a short, descriptive title summarizing what's being reviewed (e.g., "Review: Auth module refactor" or "Review: API endpoint updates and test fixes").
2. Create an epic with a timestamp for uniqueness:
```bash
EPIC_ID=$(tk create "<generated title> (<YYYY-MM-DD HH:MM>)" -t epic -p 2 --tags code-review -d "<brief summary of changes being reviewed>")
```
3. Note the `EPIC_ID` for passing to sub-agents.

## Step 3: Launch reviewers

Use the Task tool to invoke these specialized reviewers in parallel.

Include `REVIEW_CMD=<command>` in each prompt so reviewers know how to examine files.

### tk mode (TK_AVAILABLE=true)

Pass the epic ID and review command to each sub-agent via the prompt string:

1. Invoke the code-reviewer-1 sub-agent:
```
Task: Review code for logical correctness
Prompt: TK_MODE=true EPIC_ID=<epic_id> REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt - do NOT examine any other files
SubagentType: code-reviewer-1
```

2. Invoke the code-reviewer-2 sub-agent:
```
Task: Review code for performance
Prompt: TK_MODE=true EPIC_ID=<epic_id> REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt - do NOT examine any other files
SubagentType: code-reviewer-2
```

3. Invoke the code-reviewer-3 sub-agent:
```
Task: Review code for readability
Prompt: TK_MODE=true EPIC_ID=<epic_id> REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt - do NOT examine any other files
SubagentType: code-reviewer-3
```

4. Invoke the security-reviewer sub-agent:
```
Task: Review code for security issues
Prompt: TK_MODE=true EPIC_ID=<epic_id> REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt - do NOT examine any other files
SubagentType: security-reviewer
```

### File mode (TK_AVAILABLE=false)

Pass the review command without tk parameters:

1. Invoke the code-reviewer-1 sub-agent:
```
Task: Review code for logical correctness
Prompt: REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt - do NOT examine any other files
SubagentType: code-reviewer-1
```

2. Invoke the code-reviewer-2 sub-agent:
```
Task: Review code for performance
Prompt: REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt - do NOT examine any other files
SubagentType: code-reviewer-2
```

3. Invoke the code-reviewer-3 sub-agent:
```
Task: Review code for readability
Prompt: REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt - do NOT examine any other files
SubagentType: code-reviewer-3
```

4. Invoke the security-reviewer sub-agent:
```
Task: Review code for security issues
Prompt: REVIEW_CMD=<review_cmd> -- Review ONLY files in .code-review/changed-files.txt - do NOT examine any other files
SubagentType: security-reviewer
```

## Step 4: Coordination

After all reviewers complete their analysis, invoke the review-coordinator sub-agent:

### tk mode
```
Task: Compile review findings
Prompt: TK_MODE=true EPIC_ID=<epic_id> -- Aggregate review findings, deduplicate, and present summary
SubagentType: review-coordinator
```

### File mode
```
Task: Compile review findings
Prompt: Combine all reviewer findings, combine duplicates, and write the final report to .code-review/final-report.md
SubagentType: review-coordinator
```

## Step 5: Completion

### tk mode
When complete, inform the user that the review is finished and provide the epic ID. Tell them they can browse tickets with:
- `tk show <id>` - View details of a specific ticket
- `tk query '.[] | select(.parent=="<epic_id>")'` - List all review tickets

### File mode
When complete, inform the user that the review is finished and present the final report from .code-review/final-report.md.
