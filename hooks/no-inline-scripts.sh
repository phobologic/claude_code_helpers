#!/usr/bin/env bash
# Flags Bash invocations that should use a dedicated tool (Write/Edit/Read/
# Grep/Glob) or a real script file under .tmp/ instead. Forces a user prompt
# (permissionDecision: ask) so Claude can't quietly default to these patterns,
# but the user can still approve case-by-case when nothing else fits.
#
# Patterns flagged:
#   - Inline interpreters: python -c, python3 -c, node -e, deno eval,
#     perl -e, ruby -e
#   - Heredocs piped to interpreters/shells: python3 <<EOF, bash <<EOF, etc.
#   - Heredocs redirected to a file: cat > f <<EOF, cat <<EOF > f, tee f <<EOF
#
# Permitted by design (heuristic): heredoc inside command substitution with
# no file redirect — e.g. git commit -m "$(cat <<'EOF' … EOF)".

if ! command -v jq &>/dev/null; then
  exit 0
fi

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')

[ -z "$CMD" ] && exit 0

REASON=""
ALT=""

# 1. Inline interpreter flags (python -c, node -e, perl -e, ruby -e, deno eval).
#    Require the flag to be followed by a string-start token (quote, $, backtick)
#    so we don't match the literal text "python -c" inside heredoc commit messages.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:]|;&(])(python3?|node|deno|perl|ruby)[[:space:]]+(-[A-Za-z]*[ce]|eval)[[:space:]]+['"'"'"$`]'; then
  REASON="inline interpreter script (python -c / node -e / perl -e / ruby -e / deno eval)"
  ALT="Write the script to .tmp/ as a real file and execute that, or use Read/Grep/Glob/Edit directly."
fi

# 2. Heredoc fed to an interpreter or shell (python3 <<EOF, bash <<EOF, ...).
if [ -z "$REASON" ] && printf '%s' "$CMD" | grep -qE '(^|[[:space:]|;&(])(python3?|node|deno|perl|ruby|bash|sh|zsh)[[:space:]]*<<-?'; then
  REASON="heredoc fed to an interpreter (python3 <<EOF, bash <<EOF, ...)"
  ALT="Write the script to .tmp/ as a real file and execute that."
fi

# 3. Heredoc redirected to a file: requires both a heredoc and a file redirect
#    (>, >>, or tee FILE) somewhere in the command.
if [ -z "$REASON" ] \
   && printf '%s' "$CMD" | grep -qE '<<-?[[:space:]]*[A-Za-z_'"'"'"]' \
   && printf '%s' "$CMD" | grep -qE '(^|[[:space:]|;&(])(tee[[:space:]]+[^|&;<]+|>>?[[:space:]]*[^|&;<>[:space:]]+)'; then
  REASON="heredoc redirected to a file (cat <<EOF > path / tee path <<EOF)"
  ALT="Use the Write tool to create files and the Edit tool to modify them."
fi

[ -z "$REASON" ] && exit 0

MSG="Discouraged: $REASON. $ALT Approve only if no built-in tool can do this. See the Tool Selection section in ~/.claude/CLAUDE.md."

jq -n --arg msg "$MSG" '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": $msg
  }
}'
