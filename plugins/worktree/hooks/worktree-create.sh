#!/usr/bin/env bash
# WorktreeCreate hook — handles both pre-creation (replacement) and
# post-creation (notification) invocation modes.
#
# Claude Code may fire this hook AFTER already creating the worktree, in which
# case `git worktree add` would fail with "already exists". We detect that case
# and skip creation, but always run the .worktreelinks and .worktreeinclude setup.
set -euo pipefail

INPUT=$(cat)
WORKTREE_NAME=$(echo "$INPUT" | jq -r '.worktree_name // empty')
BRANCH=$(echo "$INPUT" | jq -r '.branch // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd')

# cd to the project root so git commands target the right repo
cd "$CWD"

# Fall back to branch name or timestamp if worktree_name is missing
if [[ -z "$WORKTREE_NAME" ]]; then
  WORKTREE_NAME="${BRANCH:-worktree-$(date +%s)}"
fi

WORKTREE_PATH="$CWD/.worktrees/$WORKTREE_NAME"

# Create the worktree only if it doesn't already exist.
# Claude Code may create the worktree before firing this hook; if so, skip
# the git command and proceed directly to the symlink/copy setup below.
if [[ ! -d "$WORKTREE_PATH" ]]; then
  if [[ -n "$BRANCH" ]]; then
    git worktree add "$WORKTREE_PATH" "$BRANCH" >&2
  else
    git worktree add "$WORKTREE_PATH" >&2
  fi
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
    ln -sfn "$src" "$dst"
    # Warn if .gitignore only has a trailing-slash pattern — those match real
    # directories but not symlinks, causing the symlink to appear as untracked.
    if [[ -d "$src" && -f "$WORKTREE_PATH/.gitignore" ]]; then
      if ! grep -qxF "$entry" "$WORKTREE_PATH/.gitignore" 2>/dev/null && \
           grep -qxF "${entry}/" "$WORKTREE_PATH/.gitignore" 2>/dev/null; then
        echo "claude-worktree: '$entry' is a directory symlink but .gitignore only has '${entry}/' — trailing-slash patterns don't match symlinks. Add '$entry' (without trailing slash) to .gitignore to prevent it appearing as untracked in worktrees." >&2
      fi
    fi
  done < "$CWD/.worktreelinks"
fi

echo "$WORKTREE_PATH"
