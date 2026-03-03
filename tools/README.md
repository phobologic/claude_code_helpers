# Tool Plugins

Each subdirectory is a Claude Code plugin providing CLI conventions and coding patterns
for deployment and database tooling.

## Available Plugins

| Plugin | Description |
|--------|-------------|
| `railway/` | Railway CLI cheat sheet and safety conventions |
| `sqlalchemy/` | SQLAlchemy async patterns and Alembic migration conventions |

## Installing into a Project

The plugin system is a two-step process: add the marketplace catalog once, then install
individual plugins per project.

**Step 1 — add the marketplace (once per machine):**
```
/plugin marketplace add ~/git/claude_code/tools
```

**Step 2 — install a plugin in your project:**
```
/plugin install claude-railway@claude-tools
/plugin install claude-sqlalchemy@claude-tools
```

This makes the plugin's `rules/CLAUDE.md` available automatically — no `settings.json`
editing required. Multiple plugins can be active simultaneously.

## Plugin Structure

```
<tool>/
├── .claude-plugin/
│   └── plugin.json        # name, version, description
└── rules/
    └── CLAUDE.md          # conventions and reference (loaded when plugin is active)
```

These plugins are rules-only (no hooks). Hooks may be added in the future if needed.

## Adding a New Tool Plugin

1. Create `tools/<tool>/`
2. Add `.claude-plugin/plugin.json` with name/version/description
3. Add `rules/CLAUDE.md` with the CLI reference and conventions
4. Register the plugin in `tools/.claude-plugin/marketplace.json`
