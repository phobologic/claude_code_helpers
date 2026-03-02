# Claude Code Config Migration: v1 → v2

This document describes what changed in the claude_code dotfiles repo and what needs
to be updated in projects that were set up using the old configuration.

## What Changed

### 1. Language configs moved and became plugins

**Old structure:**
- `go/CLAUDE.md` — Go coding conventions
- `go/settings.json` — Go PostToolUse hook config
- `go/hooks/go-fix.sh` — goimports formatter
- `python/CLAUDE.md`, `python/settings.json`, `python/hooks/ruff-fix.sh`
- `setup.sh <lang>` — installed language config into a project's `.claude/`

**New structure:**
- `languages/go/` — Go is now a Claude Code plugin
  - `languages/go/.claude-plugin/plugin.json`
  - `languages/go/hooks/hooks.json` — hooks (NOT in settings.json)
  - `languages/go/hooks/go-fix.sh`
  - `languages/go/rules/CLAUDE.md`
- `languages/python/` — same pattern
- `/plugin install ~/git/claude_code/languages/go` — installs into a project

### 2. setup.sh is gone

`setup.sh` was replaced by `/plugin install`. There is no longer a shell script to run.

**Old:** `./setup.sh go` (run in the project directory)
**New (two steps):**
```
/plugin marketplace add ~/git/claude_code/languages   # once per machine
/plugin install claude-go@claude-languages            # per project
```

### 3. Language hooks no longer live in project settings.json

**Old:** `setup.sh` copied `go/settings.json` into your project's `.claude/settings.json`.
This overwrote any existing hooks and meant you could only have one language active.

**New:** Language hooks live in the plugin's `hooks/hooks.json`. They activate when the
plugin is enabled and never touch your project's `settings.json`.

### 4. install.sh for global setup

A new `install.sh` at the repo root sets up `~/.claude/` symlinks reproducibly.

**Old:** Symlinks were created manually.
**New:** Run `./install.sh` once to configure `~/.claude/` from scratch.

## Migrating Projects Using the Old Setup

If a project was configured with `setup.sh`, it will have:
- `.claude/settings.json` with a `PostToolUse` hook referencing `.claude/hooks/go-fix.sh` or `ruff-fix.sh`
- `.claude/hooks/go-fix.sh` or `.claude/hooks/ruff-fix.sh` (symlinks or copies)
- `.claude/rules/go.md` or `.claude/rules/python.md` (symlinks or copies)

**Steps to migrate:**

1. Remove the old hook from `.claude/settings.json` (or delete the file if that's all it contained)
2. Remove the language-specific files from `.claude/hooks/` (or the whole directory if it only has those)
3. Remove the language-specific files from `.claude/rules/` (or the whole directory if it only has those)
4. Install the language plugin instead (two-step):
   ```
   # Step 1 — add the marketplace (once per machine):
   /plugin marketplace add ~/git/claude_code/languages

   # Step 2 — install in your project:
   /plugin install claude-go@claude-languages
   ```
5. Verify the hook is active by editing a `.go` file and confirming `goimports` runs

## How to Tell if a Project Uses the Old Setup

Check for these indicators:
- `.claude/settings.json` exists with a `PostToolUse` hook referencing `.claude/hooks/`
- `.claude/hooks/go-fix.sh` or `.claude/hooks/ruff-fix.sh` exists
- A `setup.sh` invocation is mentioned in project documentation
