#!/usr/bin/env bash
# SessionStart hook — two responsibilities:
#
# 1. In a linked worktree: ensure all .worktreelinks entries are symlinked
#    (safety net for worktrees created before this plugin was installed).
#
# 2. In the main worktree: if .worktreeinclude exists but .worktreelinks does
#    not, inject a one-time migration prompt into Claude's context.
#    Once .worktreelinks exists (even empty), this never fires again.
set -euo pipefail

# cd to the project root from the hook input so git commands are reliable
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[[ -n "$CWD" ]] && cd "$CWD"

GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null) || exit 0
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

# In the main worktree, git-common-dir and git-dir are the same (.git)
# In a linked worktree they differ — git-dir points into .git/worktrees/<name>
if [[ "$GIT_COMMON_DIR" == "$GIT_DIR" ]]; then
  # ── Main worktree ──────────────────────────────────────────────────────────
  # Inject migration context if .worktreeinclude exists but .worktreelinks does not.
  WORKTREEINCLUDE="$REPO_ROOT/.worktreeinclude"
  WORKTREELINKS="$REPO_ROOT/.worktreelinks"

  if [[ -f "$WORKTREEINCLUDE" && ! -f "$WORKTREELINKS" ]]; then
    ENTRIES=$(grep -v '^[[:space:]]*#' "$WORKTREEINCLUDE" | grep -v '^[[:space:]]*$' || true)
    if [[ -n "$ENTRIES" ]]; then
      ENTRY_LIST=$(echo "$ENTRIES" | sed 's/^/  - /')
      echo "[claude-worktree setup] This repo has .worktreeinclude but no .worktreelinks.

These are two different worktree behaviors:
- .worktreeinclude entries are COPIED into each worktree (independent per-worktree snapshot)
- .worktreelinks entries are SYMLINKED back to the main repo (shared state — changes anywhere are visible everywhere)

Current .worktreeinclude entries:
$ENTRY_LIST

Walk the user through each entry NOW, before doing anything else. For each one, ask whether it should be symlinked (shared state -> .worktreelinks) or copied (per-worktree -> stays in .worktreeinclude). Examples that should almost always be symlinked: .tickets/, shared config. Examples that should stay copied: .env files, per-worktree overrides.

For any directories moved to .worktreelinks (e.g. .tickets/), also check .gitignore: trailing-slash patterns like '.tickets/' match real directories but NOT symlinks, so the symlink will appear as untracked in worktrees. Ensure .gitignore has BOTH the trailing-slash form (for real directories) and the bare form without slash (for symlinks). Point this out to the user for each directory entry they move.

IMPORTANT: When you are done discussing ALL entries, you MUST write .worktreelinks to disk — even if it is completely empty. This file's existence is what prevents this prompt from appearing on every session start. Do NOT skip writing the file under any circumstances, even if the user says they don't want to move anything to .worktreelinks."
    fi
  fi
  exit 0
fi

# ── Linked worktree ──────────────────────────────────────────────────────────
# git-common-dir is an absolute path to the main repo's .git dir.
MAIN_REPO_ROOT=$(dirname "$GIT_COMMON_DIR")
WORKTREELINKS="$MAIN_REPO_ROOT/.worktreelinks"
[[ -f "$WORKTREELINKS" ]] || exit 0

while IFS= read -r entry || [[ -n "$entry" ]]; do
  [[ -z "$entry" || "$entry" =~ ^# ]] && continue
  entry="${entry%/}"  # strip trailing slash

  src="$MAIN_REPO_ROOT/$entry"
  dst="$REPO_ROOT/$entry"

  # Ensure the source exists in the main repo
  [[ -e "$src" ]] || mkdir -p "$src"

  # Already correctly symlinked — skip
  [[ -L "$dst" ]] && continue

  # If an empty directory was left by old .worktreeinclude behavior, remove it
  if [[ -d "$dst" ]]; then
    rmdir "$dst" 2>/dev/null || continue  # Non-empty: leave it, skip safely
  fi

  mkdir -p "$(dirname "$dst")"
  ln -sf "$src" "$dst"

  # Warn if .gitignore only has a trailing-slash pattern — those match real
  # directories but not symlinks, causing the symlink to appear as untracked.
  if [[ -d "$src" && -f "$REPO_ROOT/.gitignore" ]]; then
    if ! grep -qxF "$entry" "$REPO_ROOT/.gitignore" 2>/dev/null && \
         grep -qxF "${entry}/" "$REPO_ROOT/.gitignore" 2>/dev/null; then
      echo "claude-worktree: '$entry' is a directory symlink but .gitignore only has '${entry}/' — trailing-slash patterns don't match symlinks. Add '$entry' (without trailing slash) to .gitignore to prevent it appearing as untracked in this worktree."
    fi
  fi
done < "$WORKTREELINKS"
