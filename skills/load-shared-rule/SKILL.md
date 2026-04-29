---
name: load-shared-rule
description: Wire a shared opt-in rule from ~/.claude/optional_rules/ into the current project's .claude/rules/ as a symlink. Use when the user says "load the <name> shared rule", "set up shared rule X for this project", "opt in to the skeletons rule", or similar. Takes one argument — the rule name (e.g. `skeletons`).
---

# load-shared-rule

Wires a single opt-in rule from `~/.claude/optional_rules/` into the
current project's `.claude/rules/` directory as a symlink. The rule
is auto-loaded by Claude Code at the start of the next session.

## Argument

One positional argument: the rule name without extension (e.g.
`skeletons` to load `~/.claude/optional_rules/skeletons.md`).

If the user did not specify a rule name, ask them which rule to load
and list available rules with:

```
ls ~/.claude/optional_rules/
```

## Procedure

Run the following as a single bash invocation, substituting the rule
name for `RULE`. Do not split it into multiple Bash calls — the
checks chain together and short-circuit on first failure.

```bash
RULE=<name>; \
SRC="$HOME/.claude/optional_rules/$RULE.md"; \
if [[ ! -e "$SRC" ]]; then \
  echo "error: rule '$RULE' not found at $SRC"; \
  echo "available rules:"; ls "$HOME/.claude/optional_rules/"; \
  exit 1; \
fi; \
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; \
if [[ "$ROOT" == "$HOME" || "$ROOT" == "$HOME/.claude" ]]; then \
  echo "error: refusing to install into $ROOT — run from inside a project repo"; \
  exit 1; \
fi; \
DST="$ROOT/.claude/rules/$RULE.md"; \
mkdir -p "$ROOT/.claude/rules"; \
if [[ -L "$DST" ]]; then \
  CUR="$(readlink "$DST")"; \
  if [[ "$CUR" == "$SRC" ]]; then \
    echo "already linked: $DST -> $SRC"; \
    exit 0; \
  else \
    echo "conflict: $DST is a symlink to $CUR (expected $SRC) — not overwriting"; \
    exit 1; \
  fi; \
elif [[ -e "$DST" ]]; then \
  echo "conflict: $DST exists as a regular file — not overwriting"; \
  exit 1; \
fi; \
ln -s "$SRC" "$DST"; \
echo "linked: $DST -> $SRC"; \
echo "loaded rule: $RULE"; \
echo "start a fresh Claude Code session in $ROOT to pick up the rule"
```

## Reporting

After the command runs, relay its outcome to the user in one short
line. If it printed "already linked", say so and stop. If it
errored on conflict or missing rule, surface the error verbatim.
On success, remind the user to start a fresh session for the rule
to take effect.

## What this skill does NOT do

- It does not create or edit the underlying rule file. The rule
  must already exist in `~/git/claude_code/optional_rules/`.
- It does not overwrite existing files or symlinks. Conflicts are
  reported and the user resolves them manually.
- It does not modify `~/.claude/optional_rules/` itself — that
  directory is a symlink to the truth directory in this repo, and
  is set up once by `install.sh`.
