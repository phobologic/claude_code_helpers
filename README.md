# Claude Code Dotfiles

Personal Claude Code dotfiles — global skills, multi-agent code review, language plugins,
tool rules, and working style rules for `~/.claude/`.

## What's Here

| Directory / File | Purpose |
|-----------------|---------|
| `skills/` | Global skills: `/review`, `/multi-review`, `/implement-ticket`, `/use-railway`, `/use-sqlalchemy`, `/migrate-beads` |
| `agents/` | 5 specialized code review sub-agents used by `/multi-review` |
| `languages/` | Per-language Claude Code plugins (Go, Python) — auto-formatting hooks + coding rules |
| `tools/` | Per-tool rule files (Railway, SQLAlchemy) — loaded via `.claude/rules/` symlinks |
| `bin/` | Utility scripts: tk plugins (`tk-show-multi`, `tk-epic-status`) and `git-auto-commit.sh` |
| `CLAUDE.global.md` | Global CLAUDE.md with personal working style rules |
| `install.sh` | Sets up `~/.claude/` symlinks from scratch |

## Installation

```bash
git clone https://github.com/you/claude_code ~/git/claude_code
cd ~/git/claude_code
./install.sh
```

This creates:
- `~/.claude/CLAUDE.md` → `CLAUDE.global.md`
- `~/.claude/skills/` → `skills/`
- `~/.claude/agents/` → `agents/`
- `~/.claude/rules/go.md` → `languages/go/rules/CLAUDE.md` *(path-scoped to `*.go` files)*
- `~/.claude/rules/python.md` → `languages/python/rules/CLAUDE.md` *(path-scoped to `*.py` files)*
- `~/.local/bin/tk-show-multi` → `bin/tk-show-multi` *(tk plugin)*
- `~/.local/bin/tk-epic-status` → `bin/tk-epic-status` *(tk plugin)*

It also adds `.tickets/` to `~/.config/git/ignore` so ticket files are never accidentally committed.

## Skills

Skills are invoked with `/skill-name` in Claude Code. After `./install.sh` the following
are available globally:

| Skill | Description |
|-------|-------------|
| `/review` | Code review of all uncommitted changes |
| `/multi-review` | Parallel review by 5 specialized agents |
| `/implement-ticket [id ...]` | Pick up and implement one or more `tk` tickets |
| `/use-railway` | Symlink Railway CLI rules into the current project |
| `/use-sqlalchemy` | Symlink SQLAlchemy/Alembic rules into the current project |
| `/migrate-beads` | Migrate a project's issue tracking from `bd` (beads) to `tk` |

## Review Skills

### `/review` — Quick Single-Pass Review

Reviews all uncommitted changes and provides feedback on correctness, security,
performance, readability, and test coverage.

### `/multi-review` — Parallel Multi-Agent Review

Coordinates 5 specialized agents working in parallel:

| Agent | Focus |
|-------|-------|
| **code-reviewer-1** | Logical correctness, best practices, architecture |
| **code-reviewer-2** | Performance, efficiency, resource usage |
| **code-reviewer-3** | Readability, maintainability, documentation |
| **security-reviewer** | Security vulnerabilities, defensive coding |
| **review-coordinator** | Aggregates, deduplicates, and prioritizes findings |

Issues are rated: **Critical**, **High**, **Medium**, **Low**.

#### Review Scope

```bash
/multi-review                    # Uncommitted changes (default)
/multi-review last 3 commits     # Recent commits
/multi-review since abc123       # Since a specific commit
/multi-review src/auth.py        # Specific files
```

#### Output

Results go to `.code-review/final-report.md`. If `tk` is installed, findings are
created as tickets directly — an epic per review session with child tickets per finding.

See [examples/multi-review-example.md](examples/multi-review-example.md) for a sample report.

## Third-Party Tool: tk

[tk](https://github.com/dleemiller/tk) is the issue tracker this config is built around.
Tickets are markdown files stored in `.tickets/` (local-only, gitignored).

### tk Plugins

`install.sh` installs two tk plugins into `~/.local/bin/`:

**`tk show-multi <id> [id2 ...]`** — show multiple tickets at once, separated by `---`.
Used extensively by `/implement-ticket` to batch-load ticket context efficiently.

**`tk epic-status`** — overview of all open epics with their child tickets grouped by
priority. Also shows unclaimed tickets not belonging to any epic.

### Workflow with `/implement-ticket`

The `/implement-ticket` skill automates the full ticket lifecycle:

1. With no arguments: shows ready (unblocked) work and suggests what to tackle next
2. With IDs: loads those tickets, triages complexity, and walks through design → plan → implement → test → commit → close

```bash
/implement-ticket              # suggest next ticket from ready list
/implement-ticket 42           # implement a specific ticket
/implement-ticket 42 43        # implement multiple tickets sequentially
/implement-ticket 42 -- skip the migration, just update the model
```

## Language Plugins

Language plugins provide **auto-formatting hooks** (goimports for Go, ruff for Python).
Coding convention rules are installed globally by `./install.sh` — no extra step.

To activate formatting hooks in a specific project:

**Step 1 — add the marketplace once per machine:**
```
/plugin marketplace add ~/git/claude_code/languages
```

**Step 2 — install in your project:**
```
/plugin install claude-go@claude-languages
/plugin install claude-python@claude-languages
```

See [`languages/README.md`](languages/README.md) for plugin structure details.

## Tool Rules

CLI reference and conventions for deployment and database tooling. Rules are loaded
per-project via `.claude/rules/` symlinks. Use the global skills to set them up:

```
/use-railway      # Railway CLI conventions (run in your project)
/use-sqlalchemy   # SQLAlchemy async + Alembic conventions (run in your project)
```

Claude will create the symlink automatically. See [`tools/README.md`](tools/README.md) for details.

## Migrating from v1

If you set up projects with the old `setup.sh`, see
[`docs/migration-v1-to-v2.md`](docs/migration-v1-to-v2.md).

## Resources

- [Claude Code Documentation](https://docs.anthropic.com/en/docs/claude-code)
- [Claude Code GitHub Repository](https://github.com/anthropics/claude-code)
