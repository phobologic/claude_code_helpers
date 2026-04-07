#!/usr/bin/env bash
# PreToolUse hook for Agent — workaround for anthropics/claude-code#33045.
#
# isolation: "worktree" is silently ignored for TeamCreate agents. This hook
# detects that combination and pre-creates the worktree at .worktrees/<name>
# so it exists before the agent spawns.
#
# The platform cannot change the agent's cwd, so the agent must cd to the
# worktree itself. The path is deterministic from the agent name, so spawn
# prompts can reference it without runtime communication.
#
# Delegates to worktree-create.sh for git worktree creation and
# .worktreelinks/.worktreeinclude setup.
set -euo pipefail

INPUT=$(cat)

# Only act on Agent calls with both isolation: "worktree" and team_name
ISOLATION=$(echo "$INPUT" | jq -r '.tool_input.isolation // empty')
TEAM_NAME=$(echo "$INPUT" | jq -r '.tool_input.team_name // empty')
[[ "$ISOLATION" == "worktree" && -n "$TEAM_NAME" ]] || exit 0

AGENT_NAME=$(echo "$INPUT" | jq -r '.tool_input.name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd')

if [[ -z "$AGENT_NAME" ]]; then
  AGENT_NAME="agent-$(date +%s)-$RANDOM"
  echo "claude-worktree: agent has no name, using $AGENT_NAME" >&2
fi

cd "$CWD"

# Only act in git repos
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

WORKTREE_PATH="$CWD/.worktrees/$AGENT_NAME"

if [[ -d "$WORKTREE_PATH" ]]; then
  echo "claude-worktree: worktree already exists at $WORKTREE_PATH" >&2
  exit 0
fi

# Delegate creation + .worktreelinks/.worktreeinclude setup to worktree-init
worktree-init "$AGENT_NAME" "$CWD" >&2

echo "claude-worktree: pre-created team agent worktree at $WORKTREE_PATH" >&2
