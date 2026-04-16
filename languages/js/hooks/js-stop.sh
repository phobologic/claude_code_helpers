#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)

# Prevent infinite loops: if the hook output caused Claude to continue and
# stop again, stop_hook_active will be true — skip re-running.
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

# Find all JS/TS/Svelte files modified since the last commit (staged + unstaged).
CHANGED_JS=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.(js|ts)$' || true)
CHANGED_SVELTE=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.svelte$' || true)

if [[ -z "$CHANGED_JS" && -z "$CHANGED_SVELTE" ]]; then
  exit 0
fi

# Find the nearest package.json from the first changed file to determine project root.
FIRST_FILE=$(echo "${CHANGED_JS:-$CHANGED_SVELTE}" | head -1)
PROJECT_DIR=$(dirname "$FIRST_FILE")
while [[ "$PROJECT_DIR" != "/" && "$PROJECT_DIR" != "." ]]; do
  if [[ -f "$PROJECT_DIR/package.json" ]]; then
    break
  fi
  PROJECT_DIR=$(dirname "$PROJECT_DIR")
done
# If we walked to ".", check the repo root
if [[ -f "package.json" ]]; then
  PROJECT_DIR="."
elif [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  exit 0
fi

cd "$PROJECT_DIR"

# Batch Biome check+fix across all modified JS/TS files.
if [[ -n "$CHANGED_JS" ]]; then
  echo "$CHANGED_JS" | xargs npx @biomejs/biome check --write 2>/dev/null || true
fi

# Batch Prettier across all modified Svelte files.
if [[ -n "$CHANGED_SVELTE" ]]; then
  echo "$CHANGED_SVELTE" | xargs npx prettier --write 2>/dev/null || true
fi

# Check pass — capture output to report violations to Claude via structured JSON.
VIOLATIONS=""

if [[ -n "$CHANGED_JS" ]]; then
  BIOME_OUTPUT=$(echo "$CHANGED_JS" | xargs npx @biomejs/biome check 2>&1 || true)
  if [[ -n "$BIOME_OUTPUT" ]]; then
    VIOLATIONS="$BIOME_OUTPUT"
  fi
fi

if [[ -n "$CHANGED_SVELTE" ]]; then
  PRETTIER_OUTPUT=$(echo "$CHANGED_SVELTE" | xargs npx prettier --check 2>&1 || true)
  if echo "$PRETTIER_OUTPUT" | grep -q "not formatted"; then
    VIOLATIONS="${VIOLATIONS:+$VIOLATIONS\n}$PRETTIER_OUTPUT"
  fi
fi

if [[ -n "$VIOLATIONS" ]]; then
  echo "{\"decision\": \"block\", \"reason\": $(echo "$VIOLATIONS" | jq -Rs .)}"
fi
