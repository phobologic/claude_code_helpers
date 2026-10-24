# Development Rules

Global rules for machines set up for software development, linked to
`~/.claude/rules/dev.md` by this repo's `install.sh`. The base rules every
machine gets are the global `~/.claude/CLAUDE.md`, which lives in the private
base-config repo.

## Testing

- **Never hit real external APIs in tests.** Always mock AI clients, payment providers,
  email services, and any other third-party API. Tests that make real network calls are
  fragile, slow, and can cause side effects.
- **Run the full test suite after editing tests**, not just the file you changed. Cross-test
  contamination (shared state, fixture ordering, monkey-patching) only shows up at the suite level.

## Issue Tracking (Tickets)

Use **tk** for all task tracking instead of markdown files, TodoWrite, or
TaskCreate. The full command reference, epic/dep model, and rules live in
`~/.claude/tk.md`; read it before any non-trivial tk work. Quick start:
`tk ready` → `tk start <id>` → work → `tk add-note <id> "..."` → `tk close <id>`.

## Living Document

CLAUDE.md is the source of truth for project conventions. When writing code:

1. Follow the patterns documented in CLAUDE.md
2. If you notice a recurring pattern not yet listed, point it out to the user
3. On user confirmation, add the pattern to `CLAUDE.local.md` (project-specific conventions that evolve during development)
4. Keep entries concise: every line should prevent a future inconsistency
