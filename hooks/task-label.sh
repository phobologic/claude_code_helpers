#!/bin/sh
# Sets the herdr $task pane token to a few-word summary of the current topic.
# Custom hook - NOT managed by herdr. Belongs beside herdr-agent-state.sh, which
# herdr overwrites on every integration update; never fold this into that file.
#
# Trigger: UserPromptSubmit. Runs its model call in the background so it adds
# no latency to the prompt, and prints nothing on stdout (UserPromptSubmit
# stdout is injected into the session as context).

set -eu

# Recursion guard: the summarizer below is itself a `claude` invocation, which
# fires this same hook. Without this it forks forever.
[ -z "${TASK_LABEL_HOOK:-}" ] || exit 0

[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0

HERDR="${HERDR_BIN_PATH:-herdr}"
command -v "$HERDR" >/dev/null 2>&1 || exit 0
command -v claude >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

prompt="$(jq -r '.prompt // empty' 2>/dev/null || true)"
[ -n "$prompt" ] || exit 0

# Very short prompts ("yes", "go on") carry no topic signal; don't spend a call.
[ "${#prompt}" -ge 12 ] || exit 0

pane_id="$HERDR_PANE_ID"
neutral_dir="${TMPDIR:-/tmp}"
mcp_cfg="$neutral_dir/task-label-empty-mcp.json"
[ -f "$mcp_cfg" ] || printf '%s\n' '{"mcpServers":{}}' >"$mcp_cfg"

(
  pane_json="$("$HERDR" pane get "$pane_id" 2>/dev/null || true)"
  current="$(printf '%s' "$pane_json" | jq -r '.result.pane.tokens.task // empty' 2>/dev/null || true)"
  # Seed from Claude Code's own OSC title when no label exists yet. A resumed
  # session already has an accurate title; using it means the pane is labelled
  # correctly from the first prompt with nothing invented.
  title="$(printf '%s' "$pane_json" | jq -r '.result.pane.terminal_title_stripped // empty' 2>/dev/null || true)"
  if [ -z "$current" ] && [ -n "$title" ]; then
    current="$title"
    "$HERDR" pane report-metadata "$pane_id" \
      --source my:task-label --token task="$current" >/dev/null 2>&1 || true
  fi

  # The model must judge from the message alone. It is told so explicitly, and
  # the call runs from a neutral cwd so no CLAUDE.md or project context loads -
  # without that, a topicless prompt gets a label invented from whatever
  # dominates the working directory.
  request="$(printf 'Current label: "%s"\nNew user message: """\n%s\n"""\n\nYou label a terminal pane with the topic of the work in it.\nUse ONLY the new user message. You have no other knowledge of this session.\nIf the message states a topic that differs from the current label, reply with a label of 3 to 5 lowercase words.\nIf it continues the current topic, or states no topic of its own, reply exactly NOCHANGE.\nNever guess or invent a topic. Reply with the label or NOCHANGE and nothing else.\n' \
    "$current" "$prompt")"

  cd "$neutral_dir" || exit 0

  label="$(printf '%s' "$request" \
    | env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_PANE_ID \
          -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_BIN_PATH \
          TASK_LABEL_HOOK=1 \
      claude -p --model haiku --strict-mcp-config --mcp-config "$mcp_cfg" 2>/dev/null || true)"

  label="$(printf '%s' "$label" | tr -d '\n' | sed 's/^ *//; s/ *$//')"

  [ -n "$label" ] || exit 0
  [ "$label" != "NOCHANGE" ] || exit 0
  # Punctuation or paragraph length means the model failed to comply.
  printf '%s' "$label" | grep -qE '^[a-z0-9][a-z0-9 _-]{2,47}$' || exit 0

  "$HERDR" pane report-metadata "$pane_id" \
    --source my:task-label --token task="$label" >/dev/null 2>&1 || true
) >/dev/null 2>&1 &

exit 0
