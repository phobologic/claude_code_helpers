---
name: ticket-triage
description: Triage, filter, and sort tk tickets for review. Use when the user asks to review open tickets, sort by priority/type/confidence, triage a backlog, go through P2 bugs, or any similar ticket review workflow. Always use tk triage instead of inline Python/jq for filtering and sorting.
argument-hint: "[-- filter and sort instructions]"
---

# Ticket Triage

Use `tk triage` to filter and sort tickets. **Never write inline Python or pipe through
`jq` for this** — `tk triage` handles multi-key sorting, confidence extraction, and
formatted output in a single safe command.

## Phase 1 — Understand the request

Parse `$ARGUMENTS` for filter and sort intent. Common patterns:

| User says | Flags to use |
|-----------|-------------|
| "open P2 tickets" | `--priority 2` |
| "bugs first, oldest first" | `--sort type,created --type-order bug,task,feature,chore,epic` |
| "triage the backlog" | `--status open --sort priority,created` |
| "tickets in epic X" | `--epic <id>` |
| "sort by confidence" | `--sort confidence` |
| "bugs and tasks only" | `--type bug,task` |
| "top 10" | `--limit 10` |

Default sort is `type,created` (bugs first by type order, then oldest first within each type).

## Phase 2 — Run the triage query

Run `tk triage` with the appropriate flags. Start with table output for orientation:

```
tk triage [--status STATUS] [--priority N] [--type TYPE] [--epic ID] [--tag TAG]
          [--sort FIELDS] [--limit N]
```

If you need ticket body content for deeper analysis (e.g., to evaluate relevance or
read acceptance criteria), re-run with `--json --full`:

```
tk triage --json --full [same filters]
```

This returns structured JSON including the full ticket body — use it when you need to
reason about ticket content, not just metadata.

## Phase 3 — Present and analyze

After getting the list:

1. **Display** the table output directly to the user
2. **Analyze** each ticket if asked (relevance, whether to close, priority agreement)
3. For each ticket, consider:
   - Is the title/description still relevant given current project state?
   - Does the confidence level match the evidence in the body?
   - Are there duplicates or superseded tickets?
   - Should priority be adjusted?

## Flag reference

| Flag | Description | Default |
|------|-------------|---------|
| `--status` | open, closed, in_progress, all | open |
| `--priority N` | Filter to priority level 0–4 | (all) |
| `--type TYPE[,TYPE]` | bug, task, feature, epic, chore | (all) |
| `--epic ID` | Filter by parent epic | (all) |
| `--tag TAG` | Filter by tag | (all) |
| `--sort FIELD[,FIELD]` | type, created, priority, confidence, status | type,created |
| `--type-order TYPE[,...]` | Custom type sort order | bug,task,feature,chore,epic |
| `--limit N` | Max tickets to show | (all) |
| `--json` | JSON output (metadata + confidence, no body) | false |
| `--full` | With `--json`: include full body | false |

## Confidence

Confidence is extracted from the ticket body (format-agnostic: `95%`, `0.95`,
`85/100`, `high`). When sorting by `--sort confidence`, higher confidence sorts first;
tickets without a confidence value sort last.
