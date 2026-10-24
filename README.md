# Claude Code Dotfiles

Personal Claude Code dotfiles — global skills, code review filed as tickets, a workflow-driven
ticket runner, language plugins, tool rules, and working style rules for `~/.claude/`.

## What's Here

| Directory / File | Purpose |
|-----------------|---------|
| `skills/` | Global skills: `/spec`, `/run-tickets`, `/run-status`, `/analyze-runs`, `/wrap-epic`, `/review`, `/design-sprint`, `/playwright-explore`, `/epic-tree`, `/ticket-triage`, `/setup-python-project`, `/setup-js-project`, `/setup-go-project`, `/use-railway`, `/use-sqlalchemy`, `/load-shared-rule` |
| `workflows/` | Saved Claude Code workflow scripts: `run-tickets` (launched by `/run-tickets`) |
| `agents/` | Sub-agents: spec-critic (plan review for `/spec`), run-tickets workflow (ticket-implementer, ticket-verifier, ticket-reviewer), and design-sprint (design-designer, design-evaluator) |
| `languages/` | Per-language Claude Code plugins (Go, Python, JS/SvelteKit) — auto-formatting hooks + coding rules |
| `plugins/` | General-purpose Claude Code plugins — workflow automation and tool integrations |
| `mods/` | Claude Code mods (`workflow-monitor`, `ticket-panes`, `worktree-snapshots`): hooks modules that change Claude Code's own interface or behaviour, installed from their own marketplace. See [`mods/README.md`](mods/README.md) |
| `optional_rules/` | Shared opt-in rules, wired into a project with `/load-shared-rule` |
| `tools/` | Per-tool rule files (Railway, SQLAlchemy) — loaded via `.claude/rules/` symlinks |
| `bin/` | Utility scripts: tk plugins (`tk-show-multi`, `tk-epic-status`, `tk-triage`, `tk-set`, `tk-backlog`) and `git-auto-commit.sh` |
| `tests/` | Dependency-free tests for the `run-tickets-engine` workflow script (run in Node with fake agents), `bin/run-tickets-plan`, `bin/run-tickets-setup` and `bin/run-tickets-finish`, `bin/run-tickets-gates`, and `bin/wrap-epic-plan` |
| `CLAUDE.dev.md` | Global rules for development machines (testing, tk, living document), loaded as `~/.claude/rules/dev.md` |
| `install.sh` | Sets up the `~/.claude/` dev symlinks from scratch |

## Installation

```bash
git clone https://github.com/you/claude_code ~/git/claude_code
cd ~/git/claude_code
./install.sh
```

This creates:
- `~/.claude/rules/dev.md` → `CLAUDE.dev.md` *(loads in every session)*
- `~/.claude/tk.md` → `tk.md`
- `~/.claude/skills/` → `skills/`
- `~/.claude/agents/` → `agents/`
- `~/.claude/workflows/` → `workflows/` *(saved workflow scripts, runnable as `/<name>`)*
- `~/.claude/optional_rules/` → `optional_rules/` *(opt-in rules for `/load-shared-rule`)*
- `~/.claude/rules/go.md` → `languages/go/rules/CLAUDE.md` *(path-scoped to `*.go` files)*
- `~/.claude/rules/python.md` → `languages/python/rules/CLAUDE.md` *(path-scoped to `*.py` files)*
- `~/.claude/rules/js.md` → `languages/js/rules/CLAUDE.md` *(path-scoped to `*.ts`/`*.js`/`*.svelte` files)*
- `~/.local/bin/tk-show-multi` → `bin/tk-show-multi` *(tk plugin)*
- `~/.local/bin/tk-epic-status` → `bin/tk-epic-status` *(tk plugin)*
- `~/.local/bin/tk-triage` → `bin/tk-triage` *(tk plugin)*
- `~/.local/bin/tk-set` → `bin/tk-set` *(tk plugin)*
- `~/.local/bin/tk-backlog` → `bin/tk-backlog` *(tk plugin: the repo's standing backlog epic, and duplicate search)*

It also adds `.tickets/` to `~/.config/git/ignore` so ticket files are never
accidentally committed.

**The base config is not here.** `~/.claude/settings.json`, the global
`~/.claude/CLAUDE.md` (working-style rules for any use of Claude Code) and the hook
scripts `settings.json` turns on live in a private dotfiles repo, which every machine
installs, including ones not used for development. Settings can't be in a public repo:
they hold private context (such as auto mode's description of private repos) and get
edited in place by Claude Code itself (plugin installs, `/config`), so anything added
later would be published too. There is no user-level `~/.claude/settings.local.json`
for machine-only overrides: `settings.local.json` is project-scoped.

## Skills

Skills are invoked with `/skill-name` in Claude Code. After `./install.sh` the following
are available globally:

| Skill | Description |
|-------|-------------|
| `/spec [idea]` | Turn a rough idea into a phased plan with EARS ACs, adversarial review, and `tk` tickets. Reads the code and design docs first, then asks every product decision with a recommendation |
| `/run-tickets <epic-id> \| <id> [id ...] [--resume]` | **Experimental.** The ticket runner: scheduling lives in `workflows/run-tickets-engine.js`, not an LLM team lead. Takes a spec'd epic, a batch of review findings, or a few backlog tickets, with AC verification only for tickets that have acceptance criteria. Asks you about decision-shaped tickets before dispatch, keeps tickets that share a file from running at once, and gates every merge on lint, types and tests. A gate can be scoped to the paths it covers, so a merge runs it only when it changes a file under them; the final integration check runs every gate. Watch with `/workflows`. Pre-existing medium and low findings go to the repo's backlog epic, so the epic can finish. Helpers: `bin/run-tickets-plan`, `bin/run-tickets-setup`, `bin/run-tickets-finish`, `bin/run-tickets-gates` (picks the gates a merge runs from the paths it changes), `bin/wrap-epic-plan`, `bin/worktree-reset`, `bin/tk-backlog`, `bin/review-scratch` (a throwaway copy of a branch for mutation testing) |
| `/run-status [run-id]` | Ticket-by-ticket snapshot of a `/run-tickets` run, running or finished, with per-step timing (`bin/run-tickets-status`; `--list` for recent runs) |
| `/review [level] [target]` | Claude Code's `/code-review`, with every finding filed as a `tk` ticket for `/run-tickets` |
| `/design-sprint [--scan] [-- guidance]` | Multi-agent GAN-style design sprint producing a frontend spec |
| `/playwright-explore <url> [scenario:<name>] [roles:…] [time:…] [-- scenario]` | Spawn simulated users to explore a running app and file `tk` tickets |
| `/epic-tree [--all] [epic-id ...]` | Show a tree of epics with open/closed ticket counts per level |
| `/wrap-epic [epic-id]` | Ship a finished `/run-tickets` batch: merge, prune worktrees, move non-blocking findings to the backlog epic, close epic, report what's left |
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
/spec "your idea"  →  /run-tickets <epic-id>  →  /review <branch>  →  /wrap-epic
```

**Backlog grooming** — work down the open ticket list:

```
/epic-tree  →  /ticket-triage  →  /run-tickets <ids…>  →  /wrap-epic
```

**Post-review cleanup** — act on review findings:

```
/review  →  /run-tickets <review-epic-id>  →  /wrap-epic
```

`/review` files its findings as tickets under a new `tk` epic, which
`/run-tickets` can consume directly.

**Build + validate + fix** — after a feature lands, poke it with simulated users:

```
/run-tickets  →  /playwright-explore  →  /ticket-triage  →  /run-tickets  →  /wrap-epic
```

## Spec to Merge

`/spec` and `/run-tickets` form the spec-to-execution pipeline:

```
/spec "your idea"
   │
   ├─ Reads the relevant code and design docs
   ├─ Asks every product decision, each with a recommendation
   ├─ Drafts phased plan (opening with its decisions) with EARS acceptance criteria
   ├─ Runs adversarial review via spec-critic agent
   ├─ Presents approved plan for your sign-off
   └─ Creates tk epics + tickets with dependency wiring
         │
/run-tickets <epic-id>
   │
   ├─ Plans the ticket graph and asks you about decision-shaped tickets
   ├─ Sets up an integration branch and a pool of worktree slots
   ├─ Runs the run-tickets-engine workflow; for each ticket, fresh agents:
   │     ticket-implementer → ticket-verifier (when it has ACs) → ticket-reviewer
   ├─ Merges passing tickets one at a time, each merge gated on lint, types and tests
   └─ Records outcomes in tk, files findings, removes worktrees and merged branches
         │
/wrap-epic   (merge to main, move non-blocking findings to the backlog, close the epic)
```

`/run-tickets` also takes a list of ticket IDs, so the same command covers a spec'd
epic, a batch of `/review` findings, or a few backlog tickets. Watch a run with
`/workflows` or `/run-status`. The details are in `skills/run-tickets/SKILL.md` and
this repo's `CLAUDE.md`.

| Agent | Role | Model |
|-------|------|-------|
| **spec-critic** | Adversarial plan review (used by `/spec` before you see the plan) | sonnet |
| **ticket-implementer** | Implements one ticket, or one rework round, in its worktree slot | opus |
| **ticket-verifier** | Binary check of each acceptance criterion, backed by quoted code and tests | sonnet |
| **ticket-reviewer** | Adversarial diff review; files out-of-scope findings as `tk` tickets | opus |

## Review Skills

### `/review` — /code-review, Filed as Tickets

Runs Claude Code's built-in `/code-review`, then files each finding as a `tk`
ticket under a new review epic, ready for `/run-tickets`. It takes the same level
and target as `/code-review`:

```bash
/review                          # current branch's diff plus uncommitted changes, at high
/review xhigh                    # the same, at extra-high effort
/review high feature/login       # a branch
/review 42                       # a PR
/review xhigh src/auth.py src/db # specific paths
```

Filing:

- Findings that one fix would cover become one ticket listing every location.
- Each ticket gets a priority (0-3) judged from the reported failure scenario,
  and acceptance criteria, so `/run-tickets` can verify the fix.
- A finding an open ticket already covers becomes a note on that ticket
  (`tk backlog find` first).
- Pre-existing medium and low findings in a diff review go to the repo's backlog
  epic, so the review epic holds only what the change should fix.
- A finding whose right fix is the owner's choice is tagged `decision`, and
  `/run-tickets` asks about it before any agent works on it.

`/review` doesn't take `ultra`, `--fix` or `--comment`; run `/code-review` for
those. It replaced `/multi-review` (four specialist reviewer agents), which found
about a third as many of the most serious bugs on the same code for about four
times the tokens.

## Third-Party Tool: tk

[tk](https://github.com/dleemiller/tk) is the issue tracker this config is built around.
Tickets are markdown files stored in `.tickets/` (local-only, gitignored).

### tk Plugins

`install.sh` installs two tk plugins into `~/.local/bin/`:

**`tk show-multi <id> [id2 ...]`** — show multiple tickets at once, separated by `---`.
Handy for loading several tickets' context in one call.

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
to `/spec`, which turns it into tickets for `/run-tickets`.

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

**Agent team workaround (currently inert):** Claude Code's `isolation: "worktree"`
parameter was [silently ignored](https://github.com/anthropics/claude-code/issues/33045)
for team agents. The plugin includes a `PreToolUse` hook (`agent-worktree-guard.sh`)
that pre-created the worktree at `.worktrees/<agent-name>` before the agent spawned.
The hook gates on the `Agent` call carrying **both** `isolation: "worktree"` and a
non-empty `team_name`. Since `team_name` was removed from the tool, that gate never
matches and the hook is a no-op on every spawn. `/run-tickets` does not depend on it —
`bin/run-tickets-setup` pre-creates every worktree explicitly with `worktree-init` — but
the hook needs a new trigger condition (or removal) before it does anything again.

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

## Resources

- [Claude Code Documentation](https://docs.anthropic.com/en/docs/claude-code)
- [Claude Code GitHub Repository](https://github.com/anthropics/claude-code)
