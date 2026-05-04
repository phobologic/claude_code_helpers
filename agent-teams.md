# Agent Teams

When coordinating a team of agents (`TeamCreate` → spawn → coordinate → cleanup):

**Worktree location.** Always create worktrees under `.worktrees/<name>` in
the repo root. This is the path the `claude-worktree` plugin expects and
keeps all worktrees co-located and easy to clean up. Add `.worktrees/` to
`.gitignore` if it isn't already.

**Team lead CWD is sacred.** Spawned agents inherit the team lead's CWD as
their starting directory, and Bash CWD persistence only works when the
agent starts from the repo root. If the team lead's CWD drifts (e.g. by
`cd`-ing into a worktree for merges), all subsequently spawned agents
will have broken CWD tracking. Therefore:
- **Never `cd` into a worktree from the team lead.** Use `git -C <path>`
  for merge operations instead.
- Before spawning agents at wave boundaries, verify with
  `cd $REPO_ROOT && pwd`.

**Git in worktree teams.** Implementers `cd` to their worktree at startup,
so they use plain `git` with no path qualification — their CWD is already
correct. The team lead operates from the main repo and must use
`git -C <path>` when acting on a worktree — never `cd <path> && git`.
Never use `git -C` in implementer prompts.

**Shutdown before delete.** Always send a shutdown request to all teammates
before calling `TeamDelete`. Skipping this leaves agents without a graceful
exit signal.

```
SendMessage({ to: "*", message: "type: shutdown_request" })
// wait for shutdown_response from each teammate, then:
TeamDelete()
```

The full teardown sequence is: all work complete → broadcast
`shutdown_request` → receive `shutdown_response` from each teammate →
`TeamDelete`.
