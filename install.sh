#!/usr/bin/env bash
set -euo pipefail

DOTFILES="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$HOME/.claude"

mkdir -p "$CLAUDE"

link() {
  local src="$1"
  local dst="$2"
  if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    echo "  ok:   $dst"
  elif [[ -e "$dst" ]]; then
    echo "  skip: $dst already exists (not a symlink to $src)"
  else
    ln -sf "$src" "$dst"
    echo "  link: $dst -> $src"
  fi
}

link "$DOTFILES/CLAUDE.global.md" "$CLAUDE/CLAUDE.md"
link "$DOTFILES/commands"         "$CLAUDE/commands"
link "$DOTFILES/agents"           "$CLAUDE/agents"

echo ""
echo "Done. ~/.claude/ is configured."
echo ""
echo "To add language support to a project, open Claude Code in that project and run:"
echo "  # Step 1 — add the language marketplace (once per machine):"
echo "  /plugin marketplace add $DOTFILES/languages"
echo ""
echo "  # Step 2 — install the language plugin in your project:"
echo "  /plugin install claude-go@claude-languages"
echo "  /plugin install claude-python@claude-languages"
