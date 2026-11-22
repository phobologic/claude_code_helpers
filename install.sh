#!/usr/bin/env bash
#
# install.sh - link this toolkit into ~/.claude and ~/.local/bin, and register
# its mods as user-scope plugins.
#
# Usage:
#   ./install.sh                      # toolkit from $CLAUDE_TOOLKIT or machine.env
#   ./install.sh --toolkit base|dev
#   ./install.sh --skip-plugins       # links only, no `claude plugin` commands
#
# Toolkits:
#   base  the herdr skill, plus the worktree-snapshots and project-nudge mods
#   dev   everything: all skills, agents, workflows, tk.md, optional_rules,
#         bin/ scripts, the rules files, and the workflow-monitor and
#         ticket-panes mods too
#
# Idempotent and converging: a run removes every link it owns (a symlink
# pointing into this repo) that the chosen toolkit doesn't want, so switching
# from dev to base, or deleting a skill or script, cleans up after itself.
# Real files and links pointing elsewhere are never touched.
#
# The toolkit is read from --toolkit, then $CLAUDE_TOOLKIT, then the
# CLAUDE_TOOLKIT= line in ~/.config/machine.env, which the private dotfiles
# repo's install writes. That install also owns ~/.claude/settings.json, the
# global CLAUDE.md and the hooks; this script leaves those alone.
#
set -euo pipefail

DOTFILES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="$HOME/.claude"
LOCAL_BIN="$HOME/.local/bin"
MACHINE_ENV="$HOME/.config/machine.env"

TOOLKIT=""
SKIP_PLUGINS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --toolkit) TOOLKIT="${2:-}"; shift 2 ;;
    --toolkit=*) TOOLKIT="${1#--toolkit=}"; shift ;;
    --skip-plugins) SKIP_PLUGINS=1; shift ;;
    -h|--help) sed -n '3,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$MACHINE_ENV" ]]; then
  echo "install.sh: $MACHINE_ENV is missing; install the private dotfiles repo first" >&2
  exit 1
fi

# KEY=value lines; ignore comments and whitespace. Never sourced.
machine_env() {
  sed -n "s/^[[:space:]]*$1=\([^#[:space:]]*\).*/\1/p" "$MACHINE_ENV" | tail -n 1
}

[[ -n "$TOOLKIT" ]] || TOOLKIT="${CLAUDE_TOOLKIT:-}"
[[ -n "$TOOLKIT" ]] || TOOLKIT="$(machine_env CLAUDE_TOOLKIT)"
case "$TOOLKIT" in
  base|dev) ;;
  "") echo "install.sh: CLAUDE_TOOLKIT is not set in $MACHINE_ENV (or the environment)" >&2; exit 1 ;;
  *) echo "install.sh: unknown toolkit '$TOOLKIT' (want base or dev)" >&2; exit 2 ;;
esac
echo "Toolkit: $TOOLKIT"

# --- desired links ---------------------------------------------------------

# Parallel lists: WANT_SRC[i] is linked at WANT_DST[i].
WANT_SRC=()
WANT_DST=()
want() { WANT_SRC+=("$1"); WANT_DST+=("$2"); }

wanted() {
  local dst="$1" d
  for d in "${WANT_DST[@]}"; do [[ "$d" == "$dst" ]] && return 0; done
  return 1
}

# A skill is a directory under skills/ with a SKILL.md. That leaves out
# skills/synced, where Claude Code keeps claude.ai account skills.
if [[ "$TOOLKIT" == dev ]]; then
  for dir in "$DOTFILES/skills"/*/; do
    dir="${dir%/}"
    [[ -f "$dir/SKILL.md" ]] && want "$dir" "$CLAUDE/skills/$(basename "$dir")"
  done
  want "$DOTFILES/tk.md"          "$CLAUDE/tk.md"
  want "$DOTFILES/agents"         "$CLAUDE/agents"
  want "$DOTFILES/workflows"      "$CLAUDE/workflows"
  want "$DOTFILES/optional_rules" "$CLAUDE/optional_rules"
  for script in "$DOTFILES/bin"/*; do
    [[ -f "$script" ]] && want "$script" "$LOCAL_BIN/$(basename "$script")"
  done
  want "$DOTFILES/CLAUDE.dev.md"                    "$CLAUDE/rules/dev.md"
  want "$DOTFILES/languages/go/rules/CLAUDE.md"     "$CLAUDE/rules/go.md"
  want "$DOTFILES/languages/python/rules/CLAUDE.md" "$CLAUDE/rules/python.md"
  want "$DOTFILES/languages/js/rules/CLAUDE.md"     "$CLAUDE/rules/js.md"
else
  want "$DOTFILES/skills/herdr" "$CLAUDE/skills/herdr"
fi

# --- ~/.claude/skills: a real directory with one link per skill -------------

mkdir -p "$CLAUDE" "$LOCAL_BIN" "$CLAUDE/rules"

# Earlier versions linked the whole directory. Replace that link with a real
# directory, carrying over Claude Code's synced account skills.
if [[ -L "$CLAUDE/skills" ]]; then
  if [[ "$(readlink "$CLAUDE/skills")" != "$DOTFILES/skills" ]]; then
    echo "install.sh: $CLAUDE/skills is a symlink to $(readlink "$CLAUDE/skills"), not this repo; move it aside and rerun" >&2
    exit 1
  fi
  rm "$CLAUDE/skills"           # the link itself, never what it points to
  mkdir "$CLAUDE/skills"
  echo "  dir:  $CLAUDE/skills (was a link to $DOTFILES/skills)"
  if [[ -d "$DOTFILES/skills/synced" ]]; then
    mv "$DOTFILES/skills/synced" "$CLAUDE/skills/synced"
    echo "  move: $DOTFILES/skills/synced -> $CLAUDE/skills/synced"
  fi
fi
mkdir -p "$CLAUDE/skills"

# --- remove owned links the toolkit doesn't want -----------------------------

owned() { [[ -L "$1" && "$(readlink "$1")" == "$DOTFILES"/* ]]; }

for dst in "$CLAUDE"/* "$CLAUDE"/skills/* "$CLAUDE"/rules/* "$LOCAL_BIN"/*; do
  owned "$dst" || continue
  wanted "$dst" && continue
  rm "$dst"
  echo "  rmv:  $dst"
done

# --- create wanted links -----------------------------------------------------

for i in "${!WANT_DST[@]}"; do
  src="${WANT_SRC[$i]}"
  dst="${WANT_DST[$i]}"
  if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    echo "  ok:   $dst"
  elif [[ -e "$dst" || -L "$dst" ]]; then
    echo "  skip: $dst already exists (not a symlink to $src)"
  else
    ln -s "$src" "$dst"
    echo "  link: $dst -> $src"
  fi
done

# --- global git ignore -------------------------------------------------------

# tk's ticket dir. Left in place on base: an extra ignore line is harmless.
if [[ "$TOOLKIT" == dev ]]; then
  GIT_IGNORE="${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore"
  mkdir -p "$(dirname "$GIT_IGNORE")"
  if ! grep -qxF '.tickets/' "$GIT_IGNORE" 2>/dev/null; then
    echo '.tickets/' >> "$GIT_IGNORE"
    echo "  add:  .tickets/ to $GIT_IGNORE"
  else
    echo "  ok:   .tickets/ in $GIT_IGNORE"
  fi
fi

# --- mods as user-scope plugins ----------------------------------------------

BASE_MODS=(worktree-snapshots project-nudge)
DEV_MODS=(workflow-monitor ticket-panes)

if [[ "$SKIP_PLUGINS" == 1 ]]; then
  echo "  skip: plugin registration (--skip-plugins)"
else
  if ! command -v claude >/dev/null 2>&1; then
    echo "install.sh: 'claude' is not on PATH; install Claude Code and rerun (or pass --skip-plugins)" >&2
    exit 1
  fi
  PY=/usr/bin/python3; [[ -x "$PY" ]] || PY=python3

  if claude plugin marketplace list --json \
      | "$PY" -c 'import json,sys; sys.exit(0 if any(m.get("name")=="claude-mods" for m in json.load(sys.stdin)) else 1)'; then
    echo "  ok:   marketplace claude-mods"
  else
    claude plugin marketplace add "$DOTFILES/mods"
    echo "  add:  marketplace claude-mods ($DOTFILES/mods)"
  fi

  # Ids of plugins installed at user scope, enabled or not (claude-sync
  # decides enabled).
  USER_PLUGINS="$(claude plugin list --json \
    | "$PY" -c 'import json,sys; print("\n".join(p["id"] for p in json.load(sys.stdin) if p.get("scope")=="user"))')"
  has_plugin() { grep -qxF "$1" <<<"$USER_PLUGINS"; }

  install_mods=("${BASE_MODS[@]}")
  remove_mods=()
  if [[ "$TOOLKIT" == dev ]]; then
    install_mods+=("${DEV_MODS[@]}")
  else
    remove_mods=("${DEV_MODS[@]}")
  fi

  for mod in "${install_mods[@]}"; do
    if has_plugin "$mod@claude-mods"; then
      echo "  ok:   plugin $mod@claude-mods"
    else
      claude plugin install "$mod@claude-mods" --scope user
      echo "  add:  plugin $mod@claude-mods"
    fi
  done
  for mod in ${remove_mods[@]+"${remove_mods[@]}"}; do
    if has_plugin "$mod@claude-mods"; then
      claude plugin uninstall "$mod@claude-mods" --scope user
      echo "  rmv:  plugin $mod@claude-mods"
    fi
  done
fi

echo ""
echo "Done: $TOOLKIT toolkit installed."
if [[ "$TOOLKIT" == dev ]]; then
  echo ""
  echo "Language formatting hooks and the worktree plugin are per project. In Claude Code:"
  echo "  /plugin marketplace add $DOTFILES/languages   # once per machine"
  echo "  /plugin install claude-go@claude-languages    # or claude-python, claude-js"
  echo "  /plugin marketplace add $DOTFILES/plugins     # once per machine"
  echo "  /plugin install claude-worktree@phobos-plugins"
  echo "Tool rules for a project: /use-railway, /use-sqlalchemy"
fi
