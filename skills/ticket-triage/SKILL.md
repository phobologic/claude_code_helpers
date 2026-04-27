---
name: ticket-triage
description: Triage, filter, and sort tk tickets for review. Use when the user asks to review open tickets, sort by priority/type/confidence, triage a backlog, go through P2 bugs, or any similar ticket review workflow. Always use tk triage instead of inline Python/jq for filtering and sorting.
argument-hint: "[-- filter and sort instructions]"
model: haiku
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

## Phase 3 — Present

Render results in a consistent layout. Scale the layout to the size of the
result set — a 3-ticket triage doesn't need a cross-tab.

### Standard layout

```
Epic: [<id>] <title>              (or "All open tickets" if no --epic filter)

Count by priority × type:
           bug  task  feat  chore  epic  │ total
  P0         2     0     0      0     0  │    2
  P1         1     3     1      0     0  │    5
  ...

Signals:
  - N tickets total, X blocked by deps, Y blocking others
  - Oldest: <date> (<age>d) — [<id>] <title>
  - Z tickets missing Acceptance Criteria: [<id>], [<id>]
```

**Rules:**

- **Cross-tab**: only render when ≥5 tickets AND the results vary on both
  axes. If all tickets share a priority or a type, drop the cross-tab and
  use a one-line count.
- **Signals**: always include. Compute from the result set — blocked = has
  an open dep; blocking = is a dep of another open ticket; missing-AC = body
  has no `## Acceptance Criteria` section.
- **No ticket list by default.** Triage is about shape, not enumeration.
  Only list individual tickets when the user explicitly asks ("show me the
  tickets", "list them", "what are they"). When asked, render the detail
  table (`[id] pri type age title`, up to `--limit`, default 20).

### Multi-epic results

When results span ≥2 epics (no `--epic` filter, or the filter matched a
parent with sub-epics), render **one section per epic** using the standard
layout above, preceded by a roll-up.

### Hierarchical epics (e.g. /spec top → phase sub-epics)

`tk triage --epic ID` only returns direct children. If any result row has
`type=epic`, treat those as sub-epics and **auto-expand one level**: run
`tk triage --epic <sub-epic>` for each and render nested.

```
Epic: [TOP] <title>

Roll-up (all descendants):
  N tickets, X blocked, Y missing ACs, oldest <age>d

By phase:
  Phase              tickets  P0  P1  P2  bugs  tasks  blocked
  [P1] <name>          5       0   2   3     1      4        0
  [P2] <name>          8       1   3   4     2      6        2
  ...

[P1] <name>
  <standard layout>

[P2] <name>
  <standard layout>
```

**Rules for hierarchy:**

- **Recurse one level only.** For deeper nesting (sub-sub-epics), print a
  one-liner pointing at the drill-in command rather than silently expanding:
  `[P2] contains sub-epic [X] — run `tk triage --epic X` to drill in`.
- **Empty phases collapse** to a one-liner: `[P1] <name> — all closed`.
- **Filter + hierarchy interaction**: if the user combined `--epic TOP`
  with a type filter (e.g., `--type bug`), the phase-epic rows get filtered
  out and you lose the structure. Query the hierarchy first *without* the
  type filter to learn the sub-epic IDs, then apply the type filter per
  phase so grouping survives.
- **Roll-up row** sums across all expanded phases — keep the totals honest.

## Phase 4 — Analyze (when asked)

If the user asks for analysis, go ticket-by-ticket and consider:
- Is the title/description still relevant given current project state?
- Does the confidence level match the evidence in the body?
- Are there duplicates or superseded tickets?
- Should priority be adjusted?

Don't volunteer analysis on every triage — the layout above is the default
response; analysis is opt-in.

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
