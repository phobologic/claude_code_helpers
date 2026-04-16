#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only act on JS/TS/Svelte files
if [[ -z "$FILE_PATH" || ! "$FILE_PATH" =~ \.(js|ts|svelte)$ ]]; then
  exit 0
fi

# Find the nearest package.json to determine project root. Biome and Prettier
# need to run from the directory that has node_modules and config files.
PROJECT_DIR=$(dirname "$FILE_PATH")
while [[ "$PROJECT_DIR" != "/" ]]; do
  if [[ -f "$PROJECT_DIR/package.json" ]]; then
    break
  fi
  PROJECT_DIR=$(dirname "$PROJECT_DIR")
done

if [[ "$PROJECT_DIR" == "/" ]]; then
  exit 0
fi

cd "$PROJECT_DIR"

if [[ "$FILE_PATH" =~ \.svelte$ ]]; then
  # Prettier for Svelte files (Biome doesn't support .svelte)
  npx prettier --write "$FILE_PATH" 2>/dev/null || true
else
  # Biome for JS/TS files: lint-fix + format in one pass.
  # Allow the fix pass to exit non-zero (unfixable violations expected mid-edit).
  npx @biomejs/biome check --write "$FILE_PATH" 2>/dev/null || true

  # Report any remaining violations so Claude can address them immediately
  # rather than having them surface at git push time.
  if ! BIOME_OUTPUT=$(npx @biomejs/biome check "$FILE_PATH" 2>&1); then
    echo "$BIOME_OUTPUT" >&2
    exit 1
  fi
fi
