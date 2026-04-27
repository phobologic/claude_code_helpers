---
name: review
description: Quick code review using an adversarial sub-agent. Surfaces Critical and High issues first. Creates tk tickets for Critical/High/Medium findings if tk is available.
model: sonnet
---

You are orchestrating a fast pre-merge code review. A dedicated adversarial sub-agent does the actual reviewing so it brings a fresh, unbiased perspective.

## Step 1: Collect context

Run:

```bash
review-setup
```

Capture `TK_AVAILABLE`, `REVIEW_CMD`, and `FILES_COUNT` from the output. Also generate a session tag: `SESSION_TAG=review-$(date +%Y%m%d-%H%M)`.

## Step 2: Guard

If `FILES_COUNT` is 0, tell the user there are no uncommitted changes to review and stop.

## Step 3: Launch the code-critic sub-agent

Use the Task tool to invoke the `code-critic` sub-agent. Pass `REVIEW_CMD`, and tk parameters when available.

### tk mode (TK_AVAILABLE=true)

```
Task: Adversarial code review
Prompt: TK_MODE=true SESSION_TAG=<session_tag> REVIEW_CMD=<review_cmd> Review ONLY the files listed in .code-review/changed-files.txt and nothing else
SubagentType: code-critic
```

### non-tk mode (TK_AVAILABLE=false)

```
Task: Adversarial code review
Prompt: REVIEW_CMD=<review_cmd> Review ONLY the files listed in .code-review/changed-files.txt and nothing else
SubagentType: code-critic
```

## Step 4: Present results

The critic's output is the review. Display it.

In tk mode, additionally tell the user:
- The session tag used: `<session_tag>`
- How to find all tickets from this review: `tk query '.tags | contains(["<session_tag>"])'`
