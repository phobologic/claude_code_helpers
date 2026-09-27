# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This repository is the source of truth for `~/.claude/` — personal Claude Code dotfiles.
It provides global skills, sub-agents for multi-agent code review, a global CLAUDE.md
with working style rules, language plugins for auto-formatting, and tool rules for deployment
and database conventions.

## Repository Structure

```
skills/         Global skills (review, multi-review, implement-ticket, use-railway, …)
agents/         Sub-agents for code review, agent-team execution, and the run-tickets workflow
workflows/      Saved Claude Code workflow scripts (run-tickets)
languages/      Per-language Claude Code plugins (go, python) — hooks + rules
tools/          Per-tool rules files (railway, sqlalchemy) — loaded via .claude/rules/ symlinks
bin/            Utility scripts (tk plugins, etc.)
docs/           Documentation and migration guides
CLAUDE.global.md  Global CLAUDE.md — symlinked to ~/.claude/CLAUDE.md
install.sh      Sets up ~/.claude/ symlinks from scratch
```

## Installation

Run `./install.sh` to configure `~/.claude/`:
- `~/.claude/CLAUDE.md` → `CLAUDE.global.md`
- `~/.claude/skills/` → `skills/`
- `~/.claude/agents/` → `agents/`
- `~/.claude/workflows/` → `workflows/`
- `~/.claude/rules/go.md` → `languages/go/rules/CLAUDE.md`
- `~/.claude/rules/python.md` → `languages/python/rules/CLAUDE.md`

To add language auto-formatting hooks to a project:
```
# Step 1 — add the marketplace once per machine:
/plugin marketplace add ~/git/claude_code/languages

# Step 2 — install in your project:
/plugin install claude-go@claude-languages
/plugin install claude-python@claude-languages
```

## Architecture

### Skills
- Skills are stored in the `skills/` directory, one subdirectory per skill with a `SKILL.md`
- Invoked with `/skill-name` or automatically by Claude when context matches the description
- Skills with `disable-model-invocation: true` are user-only (for side-effect workflows)
- See the [Claude Code skills docs](https://code.claude.com/docs/en/skills) for format details

### Sub-Agents
- Specialized review agents are stored in the `agents/` directory
- Agents are used by the multi-review system to provide specialized code analysis
- The review coordinator aggregates findings from all reviewers

### Language Plugins
- Each language in `languages/` is a Claude Code plugin
- Plugins provide PostToolUse hooks for auto-formatting (goimports, ruff, biome/prettier)
- Installed per-project with `/plugin install` — no `settings.json` editing required
- Rules (coding conventions) are loaded globally via `~/.claude/rules/` symlinks set up by `install.sh`
- Rules are path-scoped: Go rules only load for `*.go` files, Python rules for `*.py` files, JS rules for `*.ts`/`*.js`/`*.svelte` files
- See `languages/README.md` for details

### Tool Rules
- `tools/` contains plain markdown rule files for deployment and database tooling
- Rules are loaded per-project by symlinking into `.claude/rules/`
- Use `/use-railway` or `/use-sqlalchemy` commands to set up symlinks automatically
- See `tools/README.md` for details

## Available Skills

### Spec and Execution
- `/spec [idea]` - Turn a rough idea into a phased plan with EARS ACs, adversarial review via spec-critic, and `tk` tickets
- `/run-epic <epic-id>` - Execute a `tk` epic with an agent team (implementers + ac-verifier + quality-reviewer)
- `/run-epic-dag <epic-id>` - **Experimental.** DAG-driven variant of `/run-epic` with continuous dispatching and a fixed agent pool (4 implementers, 2 quality reviewers, 1 AC verifier). Tickets unblock and dispatch without wave boundaries. File issues in this repo for problems encountered during real-world use.
- `/run-tickets <epic-id> | <id> [id ...] [--resume]` - **Experimental.** Workflow-backed replacement candidate for the four agent-team runners. The skill plans the ticket graph (`bin/run-tickets-plan`) and sets up worktrees; the `run-tickets` workflow script does all scheduling in code: dependency order, a pool of worktree slots, a fresh agent per step, AC verification only for tickets with acceptance criteria, capped rework, and one-at-a-time merges in a dedicated integration worktree. Watch it with `/workflows`. Findings are routed by origin: regressions and serious bugs stay in the epic (the report's "Blocking wrap" line), and other pre-existing ones go to the repo's standing backlog epic (`tk backlog`), where repeats become notes on the existing ticket.
- `/run-status [run-id]` - Ticket-by-ticket snapshot of a `/run-tickets` run, running or finished (current step or outcome, per-step timing, rework and conflict counts, findings, merges, integration check), built by `bin/run-tickets-status` from the run record in `.worktrees/`, the workflow journal, agent logs, and the finished-run metadata. `run-tickets-status --list` shows recent runs. Each ticket also gets per-agent effort, runtime token totals, lines changed, and dependents count. `run-tickets-status --archive <run-id>` (run by `/run-tickets` at the end of every run) saves the `--json` report to `~/.claude/run-history/<repo>/<run-id>.json`, which outlives Claude Code's 30-day transcript cleanup and is what cross-run analysis of effort and rework reads. Works from any session. The `/run-tickets` counterpart to `/team-status`.
- `/analyze-runs [--all-repos] [--since YYYY-MM-DD]` - Read-only analysis of archived `/run-tickets` runs to decide what to tune. `bin/run-history` does the counting from `~/.claude/run-history/`: merge, block, and rework rates and tokens per attempt, broken down by effort policy, implementation and review effort, diff size, and dependents. It also counts escapes: later findings whose `**Files**` lines blame to code a merged ticket wrote, the check that stops "fewer reworks" from being mistaken for "better." The skill applies sample-size and confounding rules before recommending anything.
- `/wrap-epic [epic-id]` - Ship a completed `/run-epic`, `/fix-tickets`, or `/run-tickets` batch: merge to main, prune worktrees, move non-blocking findings to the backlog epic (folding duplicates into existing tickets), close epic with ship note, report remaining sub-epics. Never closes the backlog epic. User-only (`disable-model-invocation: true`); confirms before any destructive action.

### Review
- `/review` - Perform standard code review of uncommitted changes
- `/multi-review` - Coordinate parallel reviews from 5 specialized agents

### Ticket Workflow
- `/implement-ticket [id ...] [-- extra instructions]` - Pick up and implement tk tickets (serial)
- `/fix-tickets <id> [id ...] | <epic-id>` - Implement a set of tickets in parallel with quality review; designed for multi-review fix batches
- `/fix-tickets-dag <id> [id ...] | <epic-id>` - **Experimental.** DAG-driven variant of `/fix-tickets` with continuous dispatching and a fixed agent pool (4 implementers, 2 quality reviewers). No AC verifier — designed for multi-review fix batches without formal acceptance criteria. File issues in this repo for problems encountered during real-world use.
- `/epic-tree [--all] [epic-id ...]` - Show a tree of epics with open/closed ticket counts per level; omit IDs to show all root epics; `--all` includes closed sub-epics
- `/team-status [epic-id]` - Consistent status snapshot for an in-flight `/run-epic`, `/fix-tickets`, or DAG variant: progress, ticket table, per-agent state, and notable events. Read-only.

### Design
- `/design-sprint [--scan] [--output <path>] [-- <guidance>]` - Three-round GAN-style design sprint: 3 sonnet designers propose independently, opus evaluator scores and issues shared briefs, team lead writes the final spec

### Exploratory Testing
- `/playwright-explore <url> [scenario:<name>] [roles:r1,r2] [time:30m] [-- scenario]` - Wave-based exploratory testing with agent recycling. Ad-hoc mode discovers routes from source code; catalog mode loads predefined scenarios from `docs/test-scenarios.md`. Agents get focused assignments per wave and are recycled between waves to prevent context exhaustion.

### Project Setup
- `/setup-python-project [name]` - Scaffold a new Python project with uv, ruff, pytest, CI
- `/setup-js-project [name]` - Scaffold a new SvelteKit project with Biome, Prettier, Vitest, CI
- `/setup-go-project [name]` - Scaffold a new Go project with Makefile, golangci-lint, CI, and two-layer git hooks (pre-commit fast gate + pre-push full gate)

### Tool Setup
- `/use-railway` - Symlink Railway CLI rules into this project's `.claude/rules/`
- `/use-sqlalchemy` - Symlink SQLAlchemy/Alembic rules into this project's `.claude/rules/`

## Execution Agent Team

Used by `/run-epic` and `/fix-tickets` to implement tickets in parallel with validation:

1. **implementer**: Reads ticket, implements, tests, commits — runs in isolated worktree (opus)
2. **ac-verifier**: Binary PASS/FAIL check against EARS acceptance criteria (sonnet) — used by `/run-epic` only
3. **quality-reviewer**: Adversarial review — correctness, security, reliability, perf; creates `tk` finding tickets (sonnet)
4. **spec-critic**: Adversarial plan review used by `/spec` before presenting to user (sonnet)

`/fix-tickets` uses implementer + quality-reviewer only (no ac-verifier) since multi-review tickets don't have formal acceptance criteria.

## Run-Tickets Workflow Agents

Used only by the `run-tickets` workflow. They never use `SendMessage`; each call is a fresh agent that returns a typed result through `StructuredOutput`. Kept separate from the team agents above so neither set carries the other's protocol.

1. **ticket-implementer** (opus; xhigh for a ticket's first round, max if 3 or more tickets transitively depend on it, high for rework and conflict rounds): implements one ticket or one rework round (AC failures, review findings, merge conflict) in the worktree its prompt names. After committing, it breaks each condition it added, one at a time, to prove a test catches it, and returns that list (`conditions`) for the reviewer, plus `src_lines_changed` for the whole ticket diff, which sizes the review
2. **ticket-verifier** (sonnet, medium): binary AC check, noted on the ticket; every criterion needs quoted code and a test assertion that could actually fail
3. **ticket-reviewer** (opus; xhigh, or high when the ticket diff has under 50 non-test lines and fewer than 3 dependents): adversarial diff review. Must resolve every risk the implementer flagged, audit that tests can fail by breaking each new condition in a `review-scratch` copy, and attack at least two risky paths before returning CLEAN (all three are required fields of its result). A re-review after REWORK gets the previous findings and the fix's commit range: it confirms each finding is fixed (`prior_findings`) and aims its test audit and attacks at the fix. Inline findings come back for rework; out-of-scope ones become `tk` tickets, tagged `regression`, `worsened` or `preexisting`, after a `tk backlog find` duplicate check

The workflow's merge step (haiku) and final integration check (sonnet) use inline prompts, not agent files.

## Multi-Review Agent Specializations

1. **code-reviewer-1**: Logical correctness, best practices, architecture
2. **code-reviewer-2**: Performance, efficiency, resource usage
3. **code-reviewer-3**: Readability, maintainability, documentation
4. **security-reviewer**: Security vulnerabilities, defensive coding
5. **review-coordinator**: Aggregates and prioritizes findings

## Code Review Process

- Reviews analyze uncommitted changes (or specific commits/files when specified)
- Multi-review creates reports in `.code-review/` directory
- Issues are rated by importance: Critical, High, Medium, Low
- Final reports include file locations and line numbers
- When `tk` is installed, `/multi-review` creates tickets directly instead of writing to `.code-review/*.md` files. An epic is created per review session with child tickets for each finding. Use `tk query '.[] | select(.parent=="<epic-id>")'` to browse results.

## Important Notes

- `CLAUDE.global.md` is symlinked to `~/.claude/CLAUDE.md` — it cannot be renamed to `CLAUDE.md` here because that would cause it to be loaded twice when working in this repo
- Review reports are generated in `.code-review/` directory
- Local settings should be in `settings.local.json` (gitignored)
