#!/usr/bin/env bash
# WorktreeCreate hook — replaces default Claude Code worktree creation.
# Implements both .worktreeinclude (copy) and .worktreelinks (symlink) behavior.
set -euo pipefail

INPUT=$(cat)
WORKTREE_NAME=$(echo "$INPUT" | jq -r '.worktree_name // empty')
BRANCH=$(echo "$INPUT" | jq -r '.branch // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd')

# Fall back to branch name or timestamp if worktree_name is missing
if [[ -z "$WORKTREE_NAME" ]]; then
  WORKTREE_NAME="${BRANCH:-worktree-$(date +%s)}"
fi

WORKTREE_PATH="$CWD/.worktrees/$WORKTREE_NAME"

# Create the worktree — redirect to stderr so only the final path goes to stdout
if [[ -n "$BRANCH" ]]; then
  git worktree add "$WORKTREE_PATH" "$BRANCH" >&2
else
  git worktree add "$WORKTREE_PATH" >&2
fi

# .worktreeinclude — copy files/dirs into the worktree (per-worktree independent copies)
if [[ -f "$CWD/.worktreeinclude" ]]; then
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    [[ -z "$entry" || "$entry" =~ ^# ]] && continue
    entry="${entry%/}"  # strip trailing slash
    src="$CWD/$entry"
    dst="$WORKTREE_PATH/$entry"
    [[ -e "$src" ]] || continue
    mkdir -p "$(dirname "$dst")"
    cp -r "$src" "$dst"
  done < "$CWD/.worktreeinclude"
fi

# .worktreelinks — symlink paths back to the main repo (shared state)
if [[ -f "$CWD/.worktreelinks" ]]; then
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    [[ -z "$entry" || "$entry" =~ ^# ]] && continue
    entry="${entry%/}"  # strip trailing slash
    src="$CWD/$entry"
    dst="$WORKTREE_PATH/$entry"
    # Ensure the source exists in the main repo before linking
    [[ -e "$src" ]] || mkdir -p "$src"
    mkdir -p "$(dirname "$dst")"
    ln -sf "$src" "$dst"
  done < "$CWD/.worktreelinks"
fi

echo "$WORKTREE_PATH"
