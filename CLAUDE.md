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
mods/           Claude Code mods (workflow-monitor), installed from their own marketplace
tools/          Per-tool rules files (railway, sqlalchemy) — loaded via .claude/rules/ symlinks
bin/            Utility scripts (tk plugins, etc.)
tests/          Tests for the run-tickets workflow script and planner (plain node / python3)
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

### Mods
- `mods/` is a plugin marketplace (`claude-mods`) of mods: hooks modules that change Claude Code's own interface or behaviour
- Installed with `claude plugin marketplace add ~/git/claude_code/mods` once, then `claude plugin install <mod>@claude-mods --scope user` (every session) or `--scope project`
- Installed mods are read from this folder, so an edit here takes effect with `/reload-plugins`
- `workflow-monitor`: a live band above the prompt with the repo's newest `/run-tickets` run (ticket state and when each current step started) and the session's running workflow agents with their start times; shows on the first workflow agent; `/workflow-monitor` shows or hides it, and a hide lasts the session
- Check a mod with `claude plugin validate mods/<mod>` and `claude plugin test mods/<mod>`; see `mods/README.md`

### Tool Rules
- `tools/` contains plain markdown rule files for deployment and database tooling
- Rules are loaded per-project by symlinking into `.claude/rules/`
- Use `/use-railway` or `/use-sqlalchemy` commands to set up symlinks automatically
- See `tools/README.md` for details

## Available Skills

### Spec and Execution
- `/spec [idea]` - Turn a rough idea into a phased plan with EARS ACs, adversarial review via spec-critic, and `tk` tickets. Reads the relevant code and design docs before asking, then asks every owner decision (anything the user would notice in the product) in one batch with a recommendation for each and, where it touches existing behavior, what the system does today, with no cap on questions. Engineering calls it makes itself are listed in the plan's Decisions section. Deps come only from Produces/Consumes links, never from shared files. Decisions the user defers become `decision`-tagged tickets that the tasks needing the answer wait on.
- `/run-epic <epic-id>` - Execute a `tk` epic with an agent team (implementers + ac-verifier + quality-reviewer)
- `/run-epic-dag <epic-id>` - **Experimental.** DAG-driven variant of `/run-epic` with continuous dispatching and a fixed agent pool (4 implementers, 2 quality reviewers, 1 AC verifier). Tickets unblock and dispatch without wave boundaries. File issues in this repo for problems encountered during real-world use.
- `/run-tickets <epic-id> | <id> [id ...] [--resume]` - **Experimental.** Workflow-backed replacement candidate for the four agent-team runners. The skill plans the ticket graph (`bin/run-tickets-plan`), puts every decision-shaped ticket to the owner before dispatch (tagged `decision`, or flagged by wording and confirmed by the lead), one at a time, each with a brief written for an owner who has not seen the ticket or the code (where it came from, what happens today, the options and what each changes, a recommendation, what it holds back), finds the project's gates, and sets up the branch, worktrees and epics with `bin/run-tickets-setup`. The lead runs on Opus because of that triage. The `run-tickets-engine` workflow script does all scheduling in code: dependency order, a pool of worktree slots (`min(8, width)`, or `--slots N`) filled with the tickets the most others wait on first, tickets that name the same file run side by side, with a shared file only breaking ties for a free slot (never `tk dep` edges, never an idle slot), a fresh agent per step, AC verification only for tickets with acceptance criteria, capped rework, and one-at-a-time merges in a dedicated integration worktree. Each merge runs the gates (lint, types, tests; check-only forms, baselined at setup) on the merged result before committing, and a failure goes back to the ticket's implementer; a fix round that commits nothing goes straight back to merge without re-review. A conflict or gate-failure round skips AC re-verification (the gates re-run the suite) and gets a resolution review of only what changed since the passing review; a ticket blocks on its third conflict. A merge step that errors with the integration tree confirmed clean (a refused command, a gate that could not run) gets one retry from a fresh agent; a second error, an error that leaves the tree in doubt, or a merge agent that dies halts further merges, since the integration worktree may be mid-merge. A halted or dead run continues with `--resume`, never the Workflow tool's `resumeFromRunId` (its cache replays only while agents are called in the original order, which this concurrent script never repeats); tickets whose branch tip already passed review (read from their notes by `run-tickets-plan`) go straight to merge. Watch it with `/workflows`. Findings are routed by origin: regressions and serious bugs stay in the epic (the report's "Blocking wrap" line), and other pre-existing ones go to the repo's standing backlog epic (`tk backlog`), where repeats become notes on the existing ticket. The workflow's result points the lead at `skills/run-tickets/finish.md`, where `bin/run-tickets-finish` records outcomes in `tk`, files `DISPUTED:` checks as `needs-human` tickets, archives the run, and removes worktrees and merged branches, and `bin/wrap-epic-plan` supplies the "Blocking wrap" list.
- `/run-status [run-id]` - Ticket-by-ticket snapshot of a `/run-tickets` run, running or finished (current step or outcome, per-step timing, when each agent started, rework and conflict counts, findings, merges, integration check), built by `bin/run-tickets-status` from the run record in `.worktrees/`, the workflow journal, agent logs, and the finished-run metadata. `run-tickets-status --list` shows recent runs. Each ticket also gets per-agent effort, runtime token totals, lines changed, and dependents count. `run-tickets-status --archive <run-id>` (run by `/run-tickets` at the end of every run) saves the `--json` report to `~/.claude/run-history/<repo>/<run-id>.json`, which outlives Claude Code's 30-day transcript cleanup and is what cross-run analysis of effort and rework reads. Works from any session. The `/run-tickets` counterpart to `/team-status`.
- `/analyze-runs [--all-repos] [--since YYYY-MM-DD]` - Read-only analysis of archived `/run-tickets` runs to decide what to tune. `bin/run-history` does the counting from `~/.claude/run-history/`: merge, block, and rework rates and tokens per attempt, broken down by effort policy, implementation and review effort, diff size, and dependents. It also counts escapes: later findings whose `**Files**` lines blame to code a merged ticket wrote, the check that stops "fewer reworks" from being mistaken for "better." The skill applies sample-size and confounding rules before recommending anything.
- `/wrap-epic [epic-id]` - Ship a completed `/run-epic`, `/fix-tickets`, or `/run-tickets` batch: merge to main, prune worktrees, move non-blocking findings to the backlog epic (folding duplicates into existing tickets), close epic with ship note, report remaining sub-epics. Never closes the backlog epic. The plan comes from `bin/wrap-epic-plan` (read-only): the integration branch, the worktrees to prune (never ones another run's record claims), and the epic's open children sorted into blocking (`regression`, `worsened`, `deferred-rework` or `needs-human` at any priority, or a P0-1 finding), movable, and unfinished. `/run-tickets` uses the same script for its "Blocking wrap" line, so the two never disagree. Given a planning epic with no branch of its own (like `/spec`'s top-level epic), it wraps the one sub-epic that has a branch, and it closes the parent epic too when nothing else is open under it. User-only (`disable-model-invocation: true`); confirms before any destructive action.

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

Used only by the `run-tickets-engine` workflow. They never use `SendMessage`; each call is a fresh agent that returns a typed result through `StructuredOutput`. Kept separate from the team agents above so neither set carries the other's protocol.

1. **ticket-implementer** (opus; xhigh for a ticket's first round, max if 3 or more tickets transitively depend on it, high for rework, conflict and gate-failure rounds): implements one ticket or one rework round (AC failures, review findings, merge conflict, failed merge gate) in the worktree its prompt names. After committing, it breaks each condition it added, one at a time, to prove a test catches it, and returns that list (`conditions`) for the reviewer, plus `src_lines_changed` for the whole ticket diff, which sizes the review. It makes engineering choices itself, but returns `failed` with `needs decision:` for an owner choice nothing settles, and verifies layers the way the project says to rather than building new test infrastructure
2. **ticket-verifier** (sonnet, medium): binary AC check, noted on the ticket; every criterion needs quoted code and a test assertion that could actually fail, unless the project verifies that layer by running the product. Then harness output counts, or the criterion passes with a `human_check` that the run's report lists for the owner. A criterion whose premise the verifier confirms is wrong also goes to the owner instead of back to rework: it passes as `DISPUTED:`, and `/run-tickets` files a `needs-human` ticket under the findings parent so it blocks the wrap until the owner signs off. The verifier gets the owner's decision and the implementer's `verification` notes (harness commands it re-runs itself)
3. **ticket-reviewer** (opus; xhigh, or high when the ticket diff has under 50 non-test lines and fewer than 3 dependents, and always high for a resolution review): adversarial diff review. Must resolve every risk the implementer flagged, audit that tests can fail by breaking each new condition in a `review-scratch` copy, and attack at least two risky paths before returning CLEAN (all three are required fields of its result). A re-review after REWORK gets the previous findings and the fix's commit range: it confirms each finding is fixed (`prior_findings`) and aims its test audit and attacks at the fix. A resolution review, after a merge conflict or failed gate, covers only what the resolver changed beyond git's own merge (`git show --remerge-diff`) and the commits on top of it, checking that neither side's work or tests were dropped. Inline findings come back for rework; out-of-scope ones become `tk` tickets, tagged `regression`, `worsened` or `preexisting` (plus `decision` when the fix is an owner's choice), after a `tk backlog find` duplicate check. Test infrastructure that works around how the project verifies a layer, or that adds a new requirement to the default test command, is a high finding

The workflow's merge step and final integration check (both sonnet, medium effort) use inline prompts, not agent files.

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

## Tests

After changing `workflows/run-tickets-engine.js`, any `bin/run-tickets-*` script, or `bin/wrap-epic-plan`, run:

```
node tests/run-tickets-workflow.test.mjs
python3 tests/run-tickets-plan.test.py
python3 tests/run-tickets-scripts.test.py
python3 tests/wrap-epic-plan.test.py
```

The workflow test runs the real script with fake agents and checks scheduling (critical-path order, shared files as a tiebreak that never idles a slot), resolution reviews, merge gates, halts, and what each agent's prompt carries. It cannot check real agent behavior or how the merge prompt's git commands behave. The planner test checks that prose in `**Files**:` lines never parses as a path and that decision wording is flagged without false positives. The scripts test runs `run-tickets-setup` and `run-tickets-finish` against throwaway git repos with a fake `tk`, and the wrap-epic-plan test checks the blocking/movable/unfinished classification and branch resolution the same way. Keep sample text in all of them generic: this repo is pushed to GitHub, so no text from other projects.

## Gate Tags

`needs-human` and `decision` (defined in `tk.md`) keep tickets away from agents until a person acts. Every ticket filer (ticket-reviewer, quality-reviewer, code-critic, `/multi-review`, `/playwright-explore`, `/spec`) tags a finding `decision` when its right fix is a choice the owner would notice in the product. Every runner (`/run-tickets`, `/run-epic`, `/run-epic-dag`, `/fix-tickets`, `/fix-tickets-dag`) skips both tags and asks the owner about decision-shaped tickets before dispatch. No runner or skill turns a shared file into a `tk dep` edge; the runners handle such tickets within the run instead (the `run-tickets-engine` workflow runs them side by side and resolves conflicts at merge; the DAG runners skip dispatch, and `/run-epic` and `/fix-tickets` use wave rules, to keep them apart).

## Important Notes

- `CLAUDE.global.md` is symlinked to `~/.claude/CLAUDE.md` — it cannot be renamed to `CLAUDE.md` here because that would cause it to be loaded twice when working in this repo
- Review reports are generated in `.code-review/` directory
- Local settings should be in `settings.local.json` (gitignored)
