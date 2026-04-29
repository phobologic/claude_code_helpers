# Optional Rules

Opt-in Claude Code rules that individual project repos can pull in via
a per-rule symlink. Unlike `~/.claude/rules/`, which Claude Code
auto-loads globally across every session, the contents of this
directory only take effect in projects that explicitly opt in.

## Architecture

Two-layer symlink chain:

```
~/git/claude_code/optional_rules/        (truth directory, git-tracked)
              ↑ directory symlink
~/.claude/optional_rules/                (stable home-side path)
              ↑ per-rule file symlink (created by load-shared-rule skill)
<project>/.claude/rules/<rule>.md        (per-project, auto-loaded)
```

The middle layer is a single directory symlink set up by `install.sh`,
not a per-file symlink. Adding a rule means dropping one file into
this directory — it's immediately reachable at
`~/.claude/optional_rules/<name>.md` with no extra setup.

Project symlinks reference the stable `~/.claude/optional_rules/` path,
never the git-repo path. If this repo ever moves, only the directory
symlink in `install.sh` needs updating; project symlinks keep working.

## Adding a new rule

1. Drop a markdown file into this directory: `optional_rules/<name>.md`.
2. That's it. It's now resolvable via `~/.claude/optional_rules/<name>.md`
   through the directory symlink — no per-file home setup.
3. From inside any project repo, invoke the `load-shared-rule` skill
   with the rule's name to wire it into that project's
   `.claude/rules/`.

## Loading a rule into a project

From inside the target project's working directory, ask Claude to
load the shared rule by name (e.g. "load the skeletons shared rule").
The `load-shared-rule` skill creates `<project>/.claude/rules/<name>.md`
as a symlink into `~/.claude/optional_rules/<name>.md`. Start a fresh
Claude Code session in that project for the rule to take effect.

## Naming conventions

- One topic per file.
- Lowercase, hyphen-separated filenames (`skeletons.md`,
  `error-handling.md`, etc.).
- Names map 1:1 across all three layers — the file in this directory,
  the home-side path, and the per-project symlink all share the same
  basename.

## Reserved path

`~/.claude/rules/` (without the `optional_` prefix) is reserved by
Claude Code for global auto-loading and is managed by `install.sh`
for language-specific rules (Go, Python, JS). Do not use it for
opt-in content.
