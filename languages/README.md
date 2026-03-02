# Language Plugins

Each subdirectory is a Claude Code plugin providing language-specific auto-formatting
and coding conventions.

## Available Languages

| Plugin | Formatter | Conventions |
|--------|-----------|-------------|
| `go/` | `goimports` on every file edit | Go code conventions |
| `python/` | `ruff check --fix` + `ruff format` on every file edit | Python code conventions |

## Installing into a Project

The plugin system is a two-step process: add the marketplace catalog once, then install
individual language plugins per project.

**Step 1 — add the marketplace (once per machine):**
```
/plugin marketplace add ~/git/claude_code/languages
```

**Step 2 — install a language plugin in your project:**
```
/plugin install claude-go@claude-languages
/plugin install claude-python@claude-languages
```

This activates the language hooks automatically — no `settings.json` editing required.
Each language can be active independently; multiple languages work simultaneously.

## Plugin Structure

```
<lang>/
├── .claude-plugin/
│   └── plugin.json        # name, version, description
├── hooks/
│   ├── hooks.json         # PostToolUse hook declaration
│   └── <lang>-fix.sh      # formatter script
└── rules/
    └── CLAUDE.md          # coding conventions (loaded when plugin is active)
```

## Adding a New Language

1. Create `languages/<lang>/`
2. Add `.claude-plugin/plugin.json` with name/version/description
3. Add `hooks/hooks.json` with PostToolUse hook referencing `${CLAUDE_PLUGIN_ROOT}/hooks/<lang>-fix.sh`
4. Add `hooks/<lang>-fix.sh` — reads file path from stdin JSON, runs formatter
5. Add `rules/CLAUDE.md` with language coding conventions
