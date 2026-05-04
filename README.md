# Claude Code Dotfiles

Personal Claude Code dotfiles — global skills, multi-agent code review, agent team execution,
language plugins, tool rules, and working style rules for `~/.claude/`.

## What's Here

| Directory / File | Purpose |
|-----------------|---------|
| `skills/` | Global skills: `/spec`, `/run-epic`, `/run-epic-dag`, `/fix-tickets`, `/fix-tickets-dag`, `/wrap-epic`, `/review`, `/multi-review`, `/implement-ticket`, `/design-sprint`, `/playwright-explore`, `/epic-tree`, `/ticket-triage`, `/team-status`, `/setup-python-project`, `/setup-js-project`, `/setup-go-project`, `/use-railway`, `/use-sqlalchemy`, `/load-shared-rule` |
| `agents/` | Sub-agents: ticket-execution (implementer, ac-verifier, quality-reviewer, spec-critic), design-sprint (design-designer, design-evaluator), 5 code review agents, and code-critic (adversarial single-pass reviewer) |
| `languages/` | Per-language Claude Code plugins (Go, Python, JS/SvelteKit) — auto-formatting hooks + coding rules |
| `plugins/` | General-purpose Claude Code plugins — workflow automation and tool integrations |
| `tools/` | Per-tool rule files (Railway, SQLAlchemy) — loaded via `.claude/rules/` symlinks |
| `bin/` | Utility scripts: tk plugins (`tk-show-multi`, `tk-epic-status`, `tk-triage`, `tk-set`) and `git-auto-commit.sh` |
| `hooks/` | Global Claude Code hooks (e.g. `no-inline-scripts.sh` — flags inline-interpreter and heredoc-to-file Bash patterns as a non-blocking, in-context nudge toward Write/Edit) |
| `CLAUDE.global.md` | Global CLAUDE.md with personal working style rules |
| `settings.global.json` | Global Claude Code settings — env, permissions, hooks, statusLine |
| `install.sh` | Sets up `~/.claude/` symlinks from scratch |

## Installation

```bash
git clone https://github.com/you/claude_code ~/git/claude_code
cd ~/git/claude_code
./install.sh
```

This creates:
- `~/.claude/CLAUDE.md` → `CLAUDE.global.md`
- `~/.claude/settings.json` → `settings.global.json`
- `~/.claude/hooks/<name>.sh` → `hooks/<name>.sh` *(every script in `hooks/`)*
- `~/.claude/skills/` → `skills/`
- `~/.claude/agents/` → `agents/`
- `~/.claude/rules/go.md` → `languages/go/rules/CLAUDE.md` *(path-scoped to `*.go` files)*
- `~/.claude/rules/python.md` → `languages/python/rules/CLAUDE.md` *(path-scoped to `*.py` files)*
- `~/.claude/rules/js.md` → `languages/js/rules/CLAUDE.md` *(path-scoped to `*.ts`/`*.js`/`*.svelte` files)*
- `~/.local/bin/tk-show-multi` → `bin/tk-show-multi` *(tk plugin)*
- `~/.local/bin/tk-epic-status` → `bin/tk-epic-status` *(tk plugin)*
- `~/.local/bin/tk-triage` → `bin/tk-triage` *(tk plugin)*
- `~/.local/bin/tk-set` → `bin/tk-set` *(tk plugin)*

It also adds `.tickets/` and `.tmp/` to `~/.config/git/ignore` so ticket files
and scratch files are never accidentally committed.

**Machine-specific overrides** go in `~/.claude/settings.local.json` (gitignored,
never tracked here). Claude Code deep-merges it on top of the symlinked
`settings.json`. Use it for personal `enabledPlugins`, `extraKnownMarketplaces`
with absolute paths, or anything you don't want in the public repo.

### Scratch files

When Claude needs to write a temporary file (long heredocs, generated prompts,
ad-hoc analysis output), `CLAUDE.global.md` instructs it to prefer a project-local
`.tmp/` directory over `/tmp`. This keeps the working directory inside the repo
and makes the artifacts inspectable after the fact. `.tmp/` is globally
gitignored by `install.sh` — no per-project setup needed.

## Skills

Skills are invoked with `/skill-name` in Claude Code. After `./install.sh` the following
are available globally:

| Skill | Description |
|-------|-------------|
| `/spec [idea]` | Turn a rough idea into a phased plan with EARS ACs, adversarial review, and `tk` tickets |
| `/run-epic <epic-id>` | Execute a `tk` epic with an agent team (implementers + AC verifier + quality reviewer) |
| `/fix-tickets <id> [id ...] \| <epic-id>` | Implement a set of tickets in parallel — designed for multi-review fix batches |
| `/review` | Code review of all uncommitted changes |
| `/multi-review` | Parallel review by 5 specialized agents |
| `/implement-ticket [id ...]` | Pick up and implement one or more `tk` tickets |
| `/design-sprint [--scan] [-- guidance]` | Multi-agent GAN-style design sprint producing a frontend spec |
| `/playwright-explore <url> [scenario:<name>] [roles:…] [time:…] [-- scenario]` | Spawn simulated users to explore a running app and file `tk` tickets |
| `/epic-tree [--all] [epic-id ...]` | Show a tree of epics with open/closed ticket counts per level |
| `/wrap-epic [epic-id]` | Ship a finished `/run-epic` or `/fix-tickets`: merge, prune worktrees, close epic, report what's left |
| `/team-status [epic-id]` | Read-only status snapshot for an in-flight `/run-epic`, `/fix-tickets`, or DAG variant |
| `/setup-python-project [name]` | Scaffold a new Python project with uv, ruff, pytest, and GitHub Actions CI |
| `/setup-js-project [name]` | Scaffold a new SvelteKit project with Biome, Prettier, Vitest, and GitHub Actions CI |
| `/setup-go-project [name]` | Scaffold a new Go project with Makefile, golangci-lint, GitHub Actions CI, and two-layer git hooks |
| `/use-railway` | Symlink Railway CLI rules into the current project |
| `/use-sqlalchemy` | Symlink SQLAlchemy/Alembic rules into the current project |
| `/load-shared-rule <name>` | Wire a shared opt-in rule from `~/.claude/optional_rules/` into the current project's `.claude/rules/` |
| `/ticket-triage` | Filter, sort, and review open tickets — use instead of inline Python/jq |

## Common Workflows

The skills are designed to compose. Four loops account for the bulk of real-world
usage:

**Feature kickoff** — turn an idea into running code:

```
/spec "your idea"  →  /run-epic <epic-id>  →  /multi-review  →  /wrap-epic
```

**Backlog grooming** — work down the open ticket list:

```
/epic-tree  →  /ticket-triage  →  /fix-tickets <ids…>  →  /wrap-epic
```

`/fix-tickets` is meant to run in tight bursts — several batches back-to-back
over an hour is normal. `/wrap-epic` ships each batch.

**Post-review cleanup** — act on review findings:

```
/multi-review  →  /fix-tickets <review-epic-id>  →  /wrap-epic
```

`/multi-review` creates a `tk` epic with one child ticket per finding, which
`/fix-tickets` can consume directly.

**Build + validate + fix** — after a feature lands, poke it with simulated users:

```
/run-epic  →  /playwright-explore  →  /ticket-triage  →  /fix-tickets  →  /wrap-epic
```

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

### Experimental DAG variants

`/run-epic-dag` and `/fix-tickets-dag` are continuous-dispatch variants of `/run-epic`
and `/fix-tickets`. They spawn a fixed agent pool at startup (up to 4 implementers,
2 quality reviewers, and — for `/run-epic-dag` — 1 AC verifier) and dispatch tickets
as soon as their dependencies clear, without wave boundaries. Pool size is right-sized
to the open ticket count, so a single-ticket run gets 1 + 1 (+ 1). File issues in this
repo for problems encountered during real-world use.

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

## Fix Tickets

`/fix-tickets` is the companion to `/run-epic` for ad-hoc parallel implementation —
primarily designed for acting on a batch of findings from `/multi-review`.

**Key difference from `/run-epic`:** tickets don't need formal EARS acceptance criteria.
There's no AC verifier in the loop — just implementers and quality reviewers.

```bash
/fix-tickets 42 43 44          # fix specific tickets
/fix-tickets <epic-id>         # fix all open tickets in an epic
```

### How it works

1. Loads tickets, filters out already-closed or in-progress ones
2. Analyzes for file-level conflicts and groups into minimum waves (bias toward parallelism)
3. Presents the grouping for your approval before doing anything
4. Spawns up to 4 implementers + 2 quality reviewers — **all reused across every wave**
5. Dispatches tickets to implementers via `SendMessage`; routes completions to reviewers
6. Merges clean tickets to an integration branch (`fix/batch-<stamp>`); routes findings back
7. On completion, suggests `git diff` and `/multi-review` before merging to main

### When to use `/fix-tickets` vs `/run-epic`

| | `/run-epic` | `/fix-tickets` |
|---|---|---|
| Tickets have | Formal EARS ACs | Prose descriptions |
| Validation | AC verifier + quality reviewer | Quality reviewer only |
| Source | `/spec`-generated epics | `/multi-review` findings, ad-hoc lists |
| Input | Single epic ID | Multiple ticket IDs or an epic ID |

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

**`tk triage [flags]`** — filter and sort tickets for review with multi-key sorting and
confidence extraction. Handles all the cases where you'd otherwise reach for inline
Python or jq:

```bash
tk triage --priority 2 --sort type,created --limit 10   # P2 tickets, bugs first, oldest first
tk triage --type bug --sort confidence                  # bugs ranked by extracted confidence
tk triage --epic pbp-rods --sort priority,created       # all tickets in an epic
tk triage --json --full                                 # structured JSON with full body
```

Confidence is extracted from ticket bodies automatically, handling all formats seen in
practice: `95%`, `0.95`, `85/100`, `high`. The `--sort confidence` flag puts
highest-confidence tickets first, unrated tickets last.

**`tk set <id> [flags]`** — update one or more attributes on a ticket in place.
Avoids the need for `tk edit` (which blocks agents) or manual `sed` on ticket files:

```bash
tk set pbp-xxxx --priority 1
tk set pbp-xxxx --type bug --priority 0
tk set pbp-xxxx --tags ui,backend
tk set pbp-xxxx --parent pbp-rods
tk set pbp-xxxx --parent none        # clear parent
```

Supports: `--priority`, `--type`, `--status`, `--assignee`, `--parent`, `--tags`.
Multiple flags apply in one call. Partial ID matching works as with other tk commands.

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

## Design Sprint

`/design-sprint` runs a multi-agent GAN-style design process to produce a frontend
design specification. Three independent designer agents propose across three rounds
of increasing concreteness; a persistent evaluator scores each round and issues a
shared brief; the team lead synthesises the final spec.

```bash
/design-sprint                              # spec for current codebase
/design-sprint --scan                       # screenshot running app first (via playwright-cli)
/design-sprint --output docs/my-spec.md    # custom output path (default: docs/design-spec.md)
/design-sprint -- dark theme, brutalist     # free-form guidance passed to all designers
/design-sprint --scan -- mobile-first       # combine flags
```

### How it works

```
Round 1: three designers propose independently (high-level direction)
          ↓ evaluator scores, issues shared brief
Round 2: three designers refine (layout + component detail)
          ↓ evaluator scores, issues shared brief
Round 3: three designers detail (spacing, type, color, states)
          ↓ evaluator synthesises → team lead writes final spec
```

Scoring weights: Design Quality 35% · Originality 30% · Functionality 25% · Craft 10%

Output is a markdown spec at `docs/design-spec.md` (or `--output` path) ready to hand
to an implementer or use as a prompt for `/run-epic`.

## Playwright Explore

`/playwright-explore` spawns a team of Playwright-driven agents to explore a running
web app as simulated users. Execution runs in **waves**: each wave, the team lead
hands out focused assignments, collects findings, and then **recycles** the agents
before the next wave — this prevents context exhaustion on long runs.

```bash
/playwright-explore http://localhost:3000
/playwright-explore http://localhost:3000 -- focus on the checkout flow
/playwright-explore http://localhost:3000 roles:host,player1,player2
/playwright-explore http://localhost:3000 time:30m
/playwright-explore http://localhost:3000 scenario:checkout-flow
```

**Two modes:**

- **Ad-hoc** (default) — routes are discovered from the source code, and agents
  improvise based on the guidance you pass after `--`.
- **Catalog** (`scenario:<name>`) — loads a predefined scenario from
  `docs/test-scenarios.md` in the target repo. Useful for reproducible runs and
  scenarios that need specific setup/teardown.

**Roles** control what each agent is trying to do. The first role is always the
session initiator (sets up state, shares join links); the rest are joiners.
Default roles: `participant-1, participant-2, participant-3`.

**`time:`** bounds the full run (e.g. `time:30m`, `time:2h`). Without it the team
lead decides when to stop based on diminishing returns.

Findings are deduplicated and filed as `tk` tickets with reproduction steps.
Browser snapshots land in `.playwright-cli/snapshots/`. Run after major feature
work or before a release to catch UX issues and broken flows.

## Project Scaffolding

`/setup-python-project` and `/setup-js-project` scaffold new projects with
opinionated defaults. Run in an empty directory or pass a project name.

```bash
/setup-python-project              # uses current directory name
/setup-python-project my-api       # creates my-api/ with full scaffold
/setup-js-project my-app           # SvelteKit scaffold
```

- **Python**: `uv` for package management, `ruff` for lint + format, `pytest`
  for testing, pre-commit hooks, and a GitHub Actions CI workflow.
- **JS**: SvelteKit with TypeScript strict mode, Biome for JS/TS lint + format,
  Prettier for Svelte files, Vitest for testing, pre-commit hooks, and CI.

Both skills finish with an initial commit so the scaffold is ready to push.

## Language Plugins

Language plugins provide **auto-formatting hooks** (goimports for Go, ruff for
Python, Biome + Prettier for JS/TS/Svelte). Python and JS also run complexity
checks on changed files (radon for Python, Biome's complexity lint for JS).
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
/plugin install claude-js@claude-languages
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

**Agent team workaround:** Claude Code's `isolation: "worktree"` parameter is
[silently ignored](https://github.com/anthropics/claude-code/issues/33045) for
agents spawned via `TeamCreate`. The plugin includes a `PreToolUse` hook
(`agent-worktree-guard.sh`) that detects this combination and pre-creates the
worktree at `.worktrees/<agent-name>` before the agent spawns. Since the platform
can't change the agent's working directory, agents must `cd` to their worktree
themselves — the path is deterministic from the agent name, so spawn prompts can
reference it directly.

To avoid collisions between concurrent sessions (or stale worktrees from crashed
runs), the `/run-epic` and `/fix-tickets` skills append a short session-unique
timestamp to implementer names (e.g. `implementer-1-483921`), which flows through
to the worktree path.

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
