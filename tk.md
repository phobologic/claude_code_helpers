# tk — Issue Tracking

Tickets are stored as markdown files in `.tickets/` (gitignored — local
only, not committed).

**When to use tickets** — Use `tk` for all task/issue tracking instead of
markdown files, TodoWrite, or TaskCreate. Create tickets before starting
work, claim them with `tk start`, and close them when done.

## Essential commands

```
tk ready                                    # Show unblocked work
tk epic-status                              # Overview of all open epics and unclaimed tickets
tk show-multi <id> [id2 id3 ...]            # View multiple tickets (PREFER over repeated tk show)
tk show <id>                                # View a single ticket
tk create "..." -t task -p 2                # Create ticket (priority 0-4)
tk start <id>                               # Claim work
tk close <id>                               # Complete work
tk dep <child> <parent>                     # child depends on parent
tk query '<jq-filter>'                      # Filter tickets with jq
tk triage [--priority N] [--type T] [--sort fields] [--limit N]   # Filter/sort for triage
tk set <id> [--priority N] [--type T] [--status S] [--assignee A] [--parent ID] [--tags T]  # Update ticket attributes
```

## Workflow

1. `tk ready` — find available work
2. `tk start <id>` — claim it
3. Do the work
4. `tk add-note <id> "Summary of what was done and any key decisions made"` — document the work
5. `tk close <id>` — mark complete

When viewing tickets, always use `tk show-multi id1 id2 ...` — even for
two tickets. Only use `tk show` when you have exactly one ID and no
others are needed.

**Note:** Always add a note before closing a ticket. Notes serve as
institutional memory — future agents and sessions can read closed
tickets to understand *why* decisions were made, not just *what* was
done. Be specific: mention files changed, approaches considered, and
any gotchas encountered.

## Epics and hierarchy

Two distinct relationships — use them correctly and often together:

- **`--parent <epic-id>`** = membership. This ticket *belongs to* this epic.
  Always use when creating tickets for an epic (no `=` sign).
- **`tk dep <blocked> <blocker>`** = ordering. The blocked ticket cannot start
  until the blocker is done. Use for sequencing, not grouping.

Use **both** when a ticket belongs to an epic and also has prerequisites:

```bash
EPIC=$(tk create "Auth system" -t epic -p 1 -d "...")

# Membership: --parent adds the ticket to the epic
T1=$(tk create "Design schema"   -t task -p 1 --parent $EPIC)
T2=$(tk create "Implement login" -t task -p 1 --parent $EPIC)
T3=$(tk create "Write tests"     -t task -p 2 --parent $EPIC)

# Ordering: dep expresses what must finish first
tk dep $T2 $T1    # login blocked until schema done
tk dep $T3 $T2    # tests blocked until login done
```

Types: `bug`, `task`, `feature`, `epic`, `chore`

## Querying tickets

`tk query` dumps all tickets as newline-delimited JSON and optionally
pipes through a jq filter:

```
tk query                                    # Dump all tickets as JSON
tk query '.type == "epic"'                  # List all epics
tk query '.parent == "<epic-id>"'           # Find children of an epic
```

## Rules

- Priority uses integers 0-4 (0=critical, 4=backlog), not words
- Never use `tk edit` — it opens `$EDITOR` which blocks agents
- Use `tk add-note <id> "text"` to append context instead of editing
- Always use `--parent` to add tickets to an epic (membership). Use `tk dep` only for execution ordering. Never substitute `tk dep` for `--parent`.
- `tk dep A B` means "A is blocked until B is done" — it does NOT mean "A belongs to B" or "A was found during B". When in doubt, use `--parent`.
- Tickets are gitignored — no need to commit them
- **Never write inline Python or jq pipelines to filter/sort tickets** — use `tk triage` instead. It handles multi-key sorting, confidence extraction from ticket bodies, and both table and JSON output in a single safe command.
- **Never use `sed` or direct file edits to update ticket fields** — use `tk set <id> --priority N --type T ...` instead. Supports priority, type, status, assignee, parent, and tags in one call.
