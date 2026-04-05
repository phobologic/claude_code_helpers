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
- `WorktreeCreate` — creates the worktree, processes both files
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
