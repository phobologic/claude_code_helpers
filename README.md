# Claude Code Dotfiles

Personal Claude Code dotfiles — global skills, multi-agent code review, agent team execution,
language plugins, tool rules, and working style rules for `~/.claude/`.

## What's Here

| Directory / File | Purpose |
|-----------------|---------|
| `skills/` | Global skills: `/spec`, `/run-epic`, `/review`, `/multi-review`, `/implement-ticket`, `/use-railway`, `/use-sqlalchemy`, `/migrate-beads` |
| `agents/` | Sub-agents: 4 ticket-execution agents (implementer, ac-verifier, quality-reviewer, spec-critic) + 5 code review agents |
| `languages/` | Per-language Claude Code plugins (Go, Python) — auto-formatting hooks + coding rules |
| `plugins/` | General-purpose Claude Code plugins — workflow automation and tool integrations |
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
| `/spec [idea]` | Turn a rough idea into a phased plan with EARS ACs, adversarial review, and `tk` tickets |
| `/run-epic <epic-id>` | Execute a `tk` epic with an agent team (implementers + AC verifier + quality reviewer) |
| `/review` | Code review of all uncommitted changes |
| `/multi-review` | Parallel review by 5 specialized agents |
| `/implement-ticket [id ...]` | Pick up and implement one or more `tk` tickets |
| `/use-railway` | Symlink Railway CLI rules into the current project |
| `/use-sqlalchemy` | Symlink SQLAlchemy/Alembic rules into the current project |
| `/migrate-beads` | Migrate a project's issue tracking from `bd` (beads) to `tk` |

## Agent Team Workflow

The `/spec` and `/run-epic` skills form a full spec-to-execution pipeline powered by
Claude Code's [agent teams](https://docs.anthropic.com/en/docs/claude-code/sub-agents).

### How it works

```
/spec "your idea"
   │
   ├─ Asks clarifying questions
   ├─ Drafts phased plan with EARS acceptance criteria
   ├─ Runs adversarial review via spec-critic agent
   ├─ Presents approved plan for your sign-off
   └─ Creates tk epics + tickets with dependency wiring
         │
/run-epic <epic-id>
   │
   ├─ Creates integration branch (epic/<id>)
   ├─ Spawns agent team:
   │     implementer-1  (opus, git worktree isolation)
   │     implementer-2  (opus, git worktree isolation)
   │     ac-verifier    (sonnet, read-only)
   │     quality-reviewer (sonnet, read-only)
   ├─ Dispatches unblocked tickets to implementers in parallel
   └─ Manages validation loop:
         implement → AC verify → quality review → merge to integration branch
         (any failure routes back to the implementer with specific feedback)
```

Each implemented ticket goes through a validation loop before merging:

1. **Implementer** writes code + tests, commits to a ticket branch, signals "done"
2. **AC verifier** checks each criterion from the ticket — binary PASS/FAIL
3. **Quality reviewer** does adversarial review (correctness, security, reliability, perf) — creates `tk` finding tickets
4. **Team lead** (`/run-epic`) merges clean tickets, routes failures back

When all tickets pass, the integration branch is ready for `/multi-review` before merging to main.

### Setting up agent teams in Claude Code

Agent teams require Claude Code's multi-agent features. No extra setup beyond
`./install.sh` — the skill and agent files are symlinked into `~/.claude/` automatically.

The `/run-epic` skill acts as **team lead**. It calls `TeamCreate`, then spawns each
teammate with the `Agent` tool using `team_name` and `name` parameters so they can
receive messages via `SendMessage`. Implementers run with `isolation: worktree` so each
works in its own copy of the repo.

**Useful keyboard shortcuts while a team is running:**

| Shortcut | Action |
|----------|--------|
| `Shift+Tab` | Toggle delegate mode (keeps team lead focused on orchestration) |
| `Shift+↓` | Cycle through active teammates |

### Execution agents

| Agent | Role | Model | Isolation |
|-------|------|-------|-----------|
| **implementer** | Reads ticket, writes code + tests, commits | opus | worktree |
| **ac-verifier** | Verifies implementation against EARS ACs — PASS/FAIL only | sonnet | none |
| **quality-reviewer** | Adversarial review, creates `tk` finding tickets | sonnet | none |
| **spec-critic** | Adversarial plan review (used by `/spec` before you see the plan) | sonnet | none |

## Review Skills

### `/review` — Quick Single-Pass Review

Reviews all uncommitted changes and provides feedback on correctness, security,
performance, readability, and test coverage.

### `/multi-review` — Parallel Multi-Agent Review

Coordinates 5 specialized code review agents working in parallel:

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

## General Plugins

General-purpose workflow plugins live in `plugins/`. Each is installed per-project from the `phobos-plugins` marketplace.

**Step 1 — add the marketplace once per machine:**
```
/plugin marketplace add ~/git/claude_code/plugins
```

**Step 2 — install in your project:**
```
/plugin install claude-worktree@phobos-plugins
```

### `claude-worktree`

Improves git worktree behavior by replacing Claude Code's default worktree creation with one that supports two config files:

- **`.worktreelinks`** — paths that are **symlinked** into each worktree (shared state: changes anywhere are visible everywhere). Use for `.tickets/`, shared config.
- **`.worktreeinclude`** — paths that are **copied** into each worktree (independent per-worktree snapshot). Use for `.env`, per-worktree overrides.

Both files are newline-delimited lists of repo-relative paths. Lines starting with `#` are treated as comments. Trailing slashes are stripped automatically.

```
# .worktreelinks — shared across all worktrees
.tickets/
.claude/rules/

# .worktreeinclude — per-worktree copies
.env
.claude/settings.local.json
```

**First-time setup:** on the first message after installing the plugin in a repo that has `.worktreeinclude` but no `.worktreelinks`, Claude will walk you through migrating entries to the right file. Once `.worktreelinks` exists (even empty) the prompt won't appear again.

**Safety net:** the `SessionStart` hook retroactively symlinks `.worktreelinks` entries in worktrees created before the plugin was installed.

**`.gitignore` note:** git's trailing-slash patterns (e.g. `.tickets/`) match real directories but not symlinks. For any directory entry in `.worktreelinks`, add both forms to `.gitignore`:

```
.tickets/   # matches the real directory in the main repo
.tickets    # matches the symlink in worktrees
```

The plugin warns automatically when it detects a missing bare entry.

See [`plugins/README.md`](plugins/README.md) for plugin structure details.

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
