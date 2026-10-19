# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This repository is the Claude Code development toolkit layered on top of `~/.claude/`:
global skills, sub-agents, the run-tickets workflow, language plugins for
auto-formatting, tool rules for deployment and database conventions, and the dev rules
(`CLAUDE.dev.md`, linked to `~/.claude/rules/dev.md`). Its `install.sh` runs only on
machines used for software development.

The base config every machine gets lives in the private `myhome` repo's
`.claude_global/`, linked by that repo's `install.sh`: `settings.json`, the global
`~/.claude/CLAUDE.md`, and the hook scripts `settings.json` turns on. A rule that applies
to any use of Claude Code goes in myhome's `CLAUDE.md`; one that only matters when writing
software goes in `CLAUDE.dev.md`. Keep each rule in exactly one of them. Settings must stay
in myhome because this repo is public, the settings hold private context (auto mode's
description of private repos), and Claude Code edits the file in place.

## Repository Structure

```
skills/         Global skills (spec, run-tickets, wrap-epic, review, use-railway, …)
agents/         Sub-agents for design sprints, /spec, and the run-tickets workflow
workflows/      Saved Claude Code workflow scripts (run-tickets)
languages/      Per-language Claude Code plugins (go, python) — hooks + rules
mods/           Claude Code mods (workflow-monitor, blast-radius, ticket-panes), installed from their own marketplace
tools/          Per-tool rules files (railway, sqlalchemy) — loaded via .claude/rules/ symlinks
bin/            Utility scripts (tk plugins, etc.)
tests/          Tests for the run-tickets workflow script and planner (plain node / python3)
docs/           Documentation and migration guides
CLAUDE.dev.md   Dev rules, symlinked to ~/.claude/rules/dev.md
install.sh      Sets up the ~/.claude/ dev symlinks from scratch
```

## Installation

Run myhome's `install.sh` first for the base config, then this repo's `./install.sh`:
- `~/.claude/rules/dev.md` → `CLAUDE.dev.md`
- `~/.claude/tk.md` → `tk.md`
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
- Sub-agents are stored in the `agents/` directory, one file each
- They serve `/spec` (spec-critic), the `run-tickets-engine` workflow (ticket-implementer, ticket-verifier, ticket-reviewer) and `/design-sprint` (design-designer, design-evaluator)
- Code review has no agents of its own: `/review` runs Claude Code's built-in `/code-review`

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
- `workflow-monitor`: a live band above the prompt with the repo's newest `/run-tickets` run (ticket state and when each current step started) and the session's running workflow agents with their start times; shows on the first workflow agent; `/workflow-monitor` shows or hides it, and a hide lasts the session. While `ticket-panes` is loaded, each unmerged ticket's id is a button that opens the ticket through `$.ticketPanes.open`; it declares no dependency on that mod, asks `$.ticketPanes.available` at session start (and on its first draw after a reload), and draws plain rows without it. It draws above what the hooks beneath it draw (another mod's band), not in its place
- `blast-radius`: holds a Bash command or Write that would delete or overwrite anything outside the repository, touch `.git`, or lose work git can't restore (untracked or modified files, an ignored `.env` or database, unmerged commits, stashes), and asks the person in the AskUserQuestion dialog; any answer but "Run it" refuses. It judges by where the files are: an agent's scratch worktree inside the repository folder and temp folders are free, so `/run-tickets` mutation checks never prompt. `hooks/parse.ts` reads the command, `bin/judge.py` checks the disk and git
- `ticket-panes`: makes tk tickets clickable. A reply block that mentions tickets (a tk-id-shaped word with a `<tickets dir>/<word>.md`, ids only in fenced code not counted) gets a dim `tickets:` row of buttons, at most 8 then `+N more`. In a main session in herdr a button opens one side pane per session, split right, with a Claude agent for the ticket that resumes the ticket's one recorded conversation (`/clear` there starts a new one); another ticket switches the pane while its agent is idle, and toasts `click again to switch anyway` while it works. The side session shows the ticket in a band above its prompt, gets its rules and the ticket in its system prompt (not where an organization manages Claude Code: `prompt.compose` and `session.compact` hooks don't run there for a plugin a person installs), hears of ticket changes as a note on the next message, and is guarded: Edit, Write and NotebookEdit only under `.tmp/`, no commit-making git (`pull` included), and while a running `/run-tickets` run holds the ticket (`run-tickets-status --find-ticket`), tk limited to reading, notes and follow-ups under the backlog epic. In that case a pane below runs `run-tickets-status --ticket <id> --watch 30 <run-id>`. Outside herdr, and from inside a side pane, a button opens a read-only ticket pane closed with Esc. Clicks need the fullscreen layout. Other plugins open tickets with `$.ticketPanes.open({ id })`. See `mods/README.md` for the limits and what each toast means
- Check a mod with `claude plugin validate mods/<mod>` and `claude plugin test mods/<mod>`; `blast-radius`'s judge also has `python3 mods/blast-radius/bin/judge.test.py`. See `mods/README.md`

### Tool Rules
- `tools/` contains plain markdown rule files for deployment and database tooling
- Rules are loaded per-project by symlinking into `.claude/rules/`
- Use `/use-railway` or `/use-sqlalchemy` commands to set up symlinks automatically
- See `tools/README.md` for details

## Available Skills

### Spec and Execution
- `/spec [idea]` - Turn a rough idea into a phased plan with EARS ACs, adversarial review via spec-critic, and `tk` tickets. Reads the relevant code and design docs before asking, then asks every owner decision (anything the user would notice in the product) in one batch with a recommendation for each and, where it touches existing behavior, what the system does today, with no cap on questions. Engineering calls it makes itself are listed in the plan's Decisions section. Deps come only from Produces/Consumes links, never from shared files. Decisions the user defers become `decision`-tagged tickets that the tasks needing the answer wait on.
- `/run-tickets <epic-id> | <id> [id ...] [--resume]` - **Experimental.** The ticket runner: a spec'd epic, a batch of review findings, or a few backlog tickets all go through it, with AC verification only for tickets that have acceptance criteria. The skill plans the ticket graph (`bin/run-tickets-plan`), puts every decision-shaped ticket to the owner before dispatch (tagged `decision`, or flagged by wording and confirmed by the lead), one at a time, each with a brief written for an owner who has not seen the ticket or the code (where it came from, what happens today, the options and what each changes, a recommendation, what it holds back), finds the project's gates, and sets up the branch, worktrees and epics with `bin/run-tickets-setup`. The lead runs on Opus because of that triage. The `run-tickets-engine` workflow script does all scheduling in code: dependency order, a pool of worktree slots (`min(8, width)`, or `--slots N`) filled with the tickets the most others wait on first, tickets that name the same file run side by side, with a shared file only breaking ties for a free slot (never `tk dep` edges, never an idle slot), a fresh agent per step, AC verification only for tickets with acceptance criteria, capped rework, and one-at-a-time merges in a dedicated integration worktree. Each merge runs the gates (lint, types, tests; check-only forms, baselined at setup) on the merged result before committing, and a failure goes back to the ticket's implementer; a fix round that commits nothing goes straight back to merge without re-review. A conflict or gate-failure round skips AC re-verification (the gates re-run the suite) and gets a resolution review of only what changed since the passing review; a ticket blocks on its third conflict. A merge step that errors with the integration tree confirmed clean (a refused command, a gate that could not run) gets one retry from a fresh agent; a second error, an error that leaves the tree in doubt, or a merge agent that dies halts further merges, since the integration worktree may be mid-merge. A halted or dead run continues with `--resume`, never the Workflow tool's `resumeFromRunId` (its cache replays only while agents are called in the original order, which this concurrent script never repeats); tickets whose branch tip already passed review (read from their notes by `run-tickets-plan`) go straight to merge. Watch it with `/workflows`. Findings are routed by origin: regressions and serious bugs stay in the epic (the report's "Blocking wrap" line), and other pre-existing ones go to the repo's standing backlog epic (`tk backlog`), where repeats become notes on the existing ticket. The workflow's result points the lead at `skills/run-tickets/finish.md`, where `bin/run-tickets-finish` records outcomes in `tk`, files `DISPUTED:` checks as `needs-human` tickets, archives the run, and removes worktrees and merged branches, and `bin/wrap-epic-plan` supplies the "Blocking wrap" list.
- `/run-status [run-id]` - Ticket-by-ticket snapshot of a `/run-tickets` run, running or finished (current step or outcome, per-step timing, when each agent started, rework and conflict counts, findings, merges, integration check), built by `bin/run-tickets-status` from the run record in `.worktrees/`, the workflow journal, agent logs, and the finished-run metadata. `run-tickets-status --list` shows recent runs. `--ticket <id>` limits the text report to the run's opening lines and that ticket's block, and `--watch <N>` draws the text report again every N seconds until Ctrl-C, for a terminal pane (`ticket-panes`' activity pane runs both). `run-tickets-status --find-ticket <id>` prints `{"run_id": ..., "state": "running"}` for the newest running run that holds the ticket unmerged and exits 0, exits 1 with nothing printed when none does, and exits 2 with the reason on stderr when it can't tell; it is `ticket-panes`' only test of whether a ticket is in a run. Each ticket also gets per-agent effort, runtime token totals, lines changed, and dependents count. `run-tickets-status --archive <run-id>` (run by `/run-tickets` at the end of every run) saves the `--json` report to `~/.claude/run-history/<repo>/<run-id>.json`, which outlives Claude Code's 30-day transcript cleanup and is what cross-run analysis of effort and rework reads. Works from any session.
- `/analyze-runs [--all-repos] [--since YYYY-MM-DD]` - Read-only analysis of archived `/run-tickets` runs to decide what to tune. `bin/run-history` does the counting from `~/.claude/run-history/`: merge, block, and rework rates and tokens per attempt, broken down by effort policy, implementation and review effort, diff size, and dependents. It also counts escapes: later findings whose `**Files**` lines blame to code a merged ticket wrote, the check that stops "fewer reworks" from being mistaken for "better." The skill applies sample-size and confounding rules before recommending anything.
- `/wrap-epic [epic-id]` - Ship a completed `/run-tickets` batch: merge to main, prune worktrees, move non-blocking findings to the backlog epic (folding duplicates into existing tickets), close epic with ship note, report remaining sub-epics. Never closes the backlog epic. The plan comes from `bin/wrap-epic-plan` (read-only): the integration branch, the worktrees to prune (never ones another run's record claims), and the epic's open children sorted into blocking (`regression`, `worsened`, `deferred-rework` or `needs-human` at any priority, or a P0-1 finding), movable, and unfinished. `/run-tickets` uses the same script for its "Blocking wrap" line, so the two never disagree. Given a planning epic with no branch of its own (like `/spec`'s top-level epic), it wraps the one sub-epic that has a branch, and it closes the parent epic too when nothing else is open under it. User-only (`disable-model-invocation: true`); confirms before any destructive action.

### Review
- `/review [level] [target] [--max-findings <n>|all]` - Runs Claude Code's built-in `/code-review` (level `high` unless given, always passed explicitly because `/code-review` otherwise reuses the last level typed; `--max-findings all` unless given), then files every finding as a `tk` ticket under a new review epic that `/run-tickets` takes directly. The target is `/code-review`'s: none for the current branch's diff plus uncommitted changes, a PR number, a branch, or paths. Filing merges findings one fix would cover, gives each a priority (0-3, from the failure scenario) and acceptance criteria, notes repeats on existing tickets after a `tk backlog find`, sends pre-existing medium and low findings to the backlog epic, and tags owner choices `decision`. It replaced `/multi-review` (four specialist reviewer agents) after a head-to-head on the same code, where `/code-review` found about three times as many of the most serious bugs for about a quarter of the tokens. User-only; `ultra`, `--fix` and `--comment` go to `/code-review` directly

### Ticket Workflow
- `/epic-tree [--all] [epic-id ...]` - Show a tree of epics with open/closed ticket counts per level; omit IDs to show all root epics; `--all` includes closed sub-epics

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

## Spec Agent

**spec-critic** (sonnet): adversarial plan review used by `/spec` before the plan is presented to the user.

## Run-Tickets Workflow Agents

Used only by the `run-tickets-engine` workflow. They never use `SendMessage`; each call is a fresh agent that returns a typed result through `StructuredOutput`.
1. **ticket-implementer** (opus; high for a ticket's first round, xhigh if 3 or more tickets transitively depend on it, high for rework, conflict and gate-failure rounds; these levels are an A/B arm since 2026-10-18, recorded in each run's policy, and `/analyze-runs` has the readout that decides whether they stay): implements one ticket or one rework round (AC failures, review findings, merge conflict, failed merge gate) in the worktree its prompt names. After committing, it breaks each condition it added, one at a time, to prove a test catches it, and returns that list (`conditions`) for the reviewer, plus `src_lines_changed` for the whole ticket diff, which sizes the review. It makes engineering choices itself, but returns `failed` with `needs decision:` for an owner choice nothing settles, and verifies layers the way the project says to rather than building new test infrastructure
2. **ticket-verifier** (sonnet, medium): binary AC check, noted on the ticket; every criterion needs quoted code and a test assertion that could actually fail, unless the project verifies that layer by running the product. Then harness output counts, or the criterion passes with a `human_check` that the run's report lists for the owner. A criterion whose premise the verifier confirms is wrong also goes to the owner instead of back to rework: it passes as `DISPUTED:`, and `/run-tickets` files a `needs-human` ticket under the findings parent so it blocks the wrap until the owner signs off. The verifier gets the owner's decision and the implementer's `verification` notes (harness commands it re-runs itself)
3. **ticket-reviewer** (opus; xhigh, or high when the ticket diff has under 50 non-test lines and fewer than 3 dependents, and always high for a resolution review): adversarial diff review. Must resolve every risk the implementer flagged, audit that tests can fail by breaking each new condition in a `review-scratch` copy, and attack at least two risky paths before returning CLEAN (all three are required fields of its result). A re-review after REWORK gets the previous findings and the fix's commit range: it confirms each finding is fixed (`prior_findings`) and aims its test audit and attacks at the fix. A resolution review, after a merge conflict or failed gate, covers only what the resolver changed beyond git's own merge (`git show --remerge-diff`) and the commits on top of it, checking that neither side's work or tests were dropped. Inline findings come back for rework; out-of-scope ones become `tk` tickets, tagged `regression`, `worsened` or `preexisting` (plus `decision` when the fix is an owner's choice), after a `tk backlog find` duplicate check. Test infrastructure that works around how the project verifies a layer, or that adds a new requirement to the default test command, is a high finding

The workflow's merge step and final integration check (both sonnet, medium effort) use inline prompts, not agent files.

## Tests

After changing `workflows/run-tickets-engine.js`, any `bin/run-tickets-*` script, `bin/run-capped`, or `bin/wrap-epic-plan`, run:

```
node tests/run-tickets-workflow.test.mjs
python3 tests/run-tickets-plan.test.py
python3 tests/run-tickets-scripts.test.py
python3 tests/wrap-epic-plan.test.py
```

The workflow test runs the real script with fake agents and checks scheduling (critical-path order, shared files as a tiebreak that never idles a slot), resolution reviews, merge gates, halts, and what each agent's prompt carries. It cannot check real agent behavior or how the merge prompt's git commands behave. The planner test checks that prose in `**Files**:` lines never parses as a path and that decision wording is flagged without false positives. The scripts test runs `run-tickets-setup` and `run-tickets-finish` against throwaway git repos with a fake `tk` (and real sleeper processes for finish's leftover-process sweep), and the wrap-epic-plan test checks the blocking/movable/unfinished classification and branch resolution the same way. The scripts test also checks that `run-capped`, the hard time limit agents put on test runs while a condition is broken, takes down a looping process group that ignores SIGTERM. Keep sample text in all of them generic: this repo is public (see Important Notes), so no text from other projects.

## Gate Tags

`needs-human` and `decision` (defined in `tk.md`) keep tickets away from agents until a person acts. Every ticket filer (ticket-reviewer, `/review`, `/playwright-explore`, `/spec`) tags a finding `decision` when its right fix is a choice the owner would notice in the product. `/run-tickets` skips both tags and asks the owner about decision-shaped tickets before dispatch. No skill turns a shared file into a `tk dep` edge; `/run-tickets` handles such tickets within the run instead (the `run-tickets-engine` workflow runs them side by side and resolves conflicts at merge).

## Important Notes

- **This repo is public on GitHub.** Keep other projects out of it: no names, paths, ticket IDs, code or data from them in files, test fixtures, or commit messages. Describe what a run or project showed in general terms instead. Private Claude config (`~/.claude/settings.json`) stays in the private `myhome` repo (see Repository Purpose)
- `CLAUDE.dev.md` is symlinked to `~/.claude/rules/dev.md`. It can't be named `CLAUDE.md` here, because then it would be loaded twice when working in this repo
- `~/.claude/settings.json`, the global `~/.claude/CLAUDE.md` and the hook scripts are not in this repo (see Repository Purpose); there is no user-level `~/.claude/settings.local.json`
- Local settings should be in `settings.local.json` (gitignored)
