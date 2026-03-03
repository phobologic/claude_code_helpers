# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This repository is the source of truth for `~/.claude/` — personal Claude Code dotfiles.
It provides global slash commands, sub-agents for multi-agent code review, a global CLAUDE.md
with working style rules, and per-language plugins for auto-formatting.

## Repository Structure

```
commands/       Global slash commands (review, multi-review, migrate-beads)
agents/         Sub-agents for multi-agent code review (5 specialized reviewers)
languages/      Per-language Claude Code plugins (go, python)
tools/          Per-tool Claude Code plugins (railway, sqlalchemy)
bin/            Utility scripts (tk plugins, etc.)
docs/           Documentation and migration guides
CLAUDE.global.md  Global CLAUDE.md — symlinked to ~/.claude/CLAUDE.md
install.sh      Sets up ~/.claude/ symlinks from scratch
```

## Installation

Run `./install.sh` to configure `~/.claude/`:
- `~/.claude/CLAUDE.md` → `CLAUDE.global.md`
- `~/.claude/commands/` → `commands/`
- `~/.claude/agents/` → `agents/`

To add language support to a project:
```
# Step 1 — add the marketplace once per machine:
/plugin marketplace add ~/git/claude_code/languages

# Step 2 — install in your project:
/plugin install claude-go@claude-languages
/plugin install claude-python@claude-languages
```

To add tool/deployment plugins to a project:
```
# Step 1 — add the marketplace once per machine:
/plugin marketplace add ~/git/claude_code/tools

# Step 2 — install in your project:
/plugin install claude-railway@claude-tools
/plugin install claude-sqlalchemy@claude-tools
```

## Architecture

### Slash Commands
- Custom slash commands are stored in the `commands/` directory
- Commands are loaded automatically and invoked using `/` prefix in interactive mode

### Sub-Agents
- Specialized review agents are stored in the `agents/` directory
- Agents are used by the multi-review system to provide specialized code analysis
- The review coordinator aggregates findings from all reviewers

### Language Plugins
- Each language in `languages/` is a Claude Code plugin
- Plugins provide PostToolUse hooks for auto-formatting and coding convention rules
- Installed per-project with `/plugin install` — no `settings.json` editing required
- See `languages/README.md` for details

### Tool Plugins
- Each tool in `tools/` is a Claude Code plugin for deployment and database tooling
- Plugins provide rules (CLI reference, conventions) loaded automatically when active
- No hooks — rules-only plugins
- See `tools/README.md` for details

## Available Commands

### Review Commands
- `/review` - Perform standard code review of uncommitted changes
- `/multi-review` - Coordinate parallel reviews from 5 specialized agents

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
