# Plugins

General-purpose Claude Code plugins for workflow automation. Each plugin is installed
per-project from the `phobos-plugins` marketplace.

## Structure

Each plugin follows this layout:

```
plugins/<name>/
├── .claude-plugin/
│   └── plugin.json       # Plugin metadata (name, version, description)
└── hooks/
    ├── hooks.json         # Hook declarations
    └── *.sh               # Hook scripts
```

Rules files (`rules/CLAUDE.md`) are omitted when the plugin handles everything via
hooks and no persistent Claude instructions are needed.

## Available Plugins

### `claude-worktree`

Replaces Claude Code's default git worktree creation to support two configuration files:

- **`.worktreelinks`** — paths symlinked into each worktree (shared state)
- **`.worktreeinclude`** — paths copied into each worktree (per-worktree snapshots)

**Hooks:**
- `WorktreeCreate` — creates the worktree, processes both config files
- `PreToolUse (Agent)` — **currently inert.** Works around
  [anthropics/claude-code#33045](https://github.com/anthropics/claude-code/issues/33045)
  where `isolation: "worktree"` was silently ignored for team agents: pre-creates the
  worktree at `.worktrees/<agent-name>` and runs `.worktreelinks`/`.worktreeinclude`
  setup. It fires only when an `Agent` call has both `isolation: "worktree"` and a
  non-empty `team_name`; `team_name` no longer exists, so the guard never matches and
  the hook exits early on every spawn. Needs a new trigger condition or removal.
- `SessionStart` — retroactively symlinks `.worktreelinks` entries in pre-existing
  worktrees; on first session after install, prompts migration from `.worktreeinclude`

## Installation

```
# Once per machine:
/plugin marketplace add ~/git/claude_code/plugins

# Per project:
/plugin install claude-worktree@phobos-plugins
```

## Adding a New Plugin

1. Create `plugins/<name>/` with the structure above
2. Add an entry to `plugins/.claude-plugin/marketplace.json`
3. Document it here and in the top-level `README.md`
