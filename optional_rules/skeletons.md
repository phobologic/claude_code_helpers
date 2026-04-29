# Skeletons (deferred-fix register)

Skeletons are deliberate stopgaps we've chosen not to fix yet. They live as
tk tickets tagged `skeleton` with a single-line `Scope:` line in the body
listing the files, globs, or module names they cover.

## Before the first code edit in a task

Run `tk skeletons-for <files-you-plan-to-touch>`. If it prints anything,
run `tk show <id>` for each match, summarize for the user in one line, and
ask whether to address now or proceed around it. Never fix a skeleton
unprompted.

This rule applies only to tasks that involve code edits. Planning, review,
and research tasks don't need to run the scan.

## Filing a new skeleton

After taking a deliberate shortcut over a known-better fix, propose filing
one inline: "This is a stopgap; should I file a skeleton for [proper fix]
with trigger [X]?" Don't file silently. Don't file vague "could be cleaner"
reactions — if you can't articulate a concrete trigger that should make us
address it later, it's not a skeleton.

For the ticket format (tags, type, priority, body sections), read
`~/.claude/optional_rules/skeletons-format.md` on demand when filing.
That doc is not auto-loaded.
