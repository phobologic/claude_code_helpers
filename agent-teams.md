# Agent Teams

When coordinating a team of agents (spawn → coordinate → shut down):

**There is no team object.** `TeamCreate` and `TeamDelete` no longer exist, and
the `Agent` tool's `team_name` parameter is accepted but ignored. A session has
one implicit team: spawning a named agent joins it, and agents are cleaned up
automatically when the session exits.

**Names are the address, and the namespace is session-wide.** `Agent({ name })`
is what makes an agent reachable — `SendMessage({ to: "<name>" })` routes by it
and `ListAgents` prints it. Because there is no per-team scoping, two concurrent
runs that both spawn `implementer-1` collide. Prefix agent names with the run's
stamp. Names must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.

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

**Shut agents down one at a time.** There is no broadcast address and no
team-level teardown call. Send each teammate a structured `shutdown_request`
by name; the teammate replies with a `shutdown_response` and the runtime then
terminates its process.

```
SendMessage({ to: "impl-1", message: { type: "shutdown_request", reason: "run complete" } })
SendMessage({ to: "impl-2", message: { type: "shutdown_request", reason: "run complete" } })
// wait for a shutdown_response from each, then:
ListAgents()                            // anything still listed did not ack
TaskStop({ task_id: "impl-2" })         // abrupt — last resort only
```

The full teardown sequence is: all work complete → `shutdown_request` to each
teammate by name → `shutdown_response` from each → `ListAgents` → `TaskStop`
whatever is still running.

`TaskStop` gives an agent no shutdown window, so never lead with it — an agent
killed mid-commit leaves its worktree in an unclear state. Do the graceful pass
first and reserve `TaskStop` for agents that never answered.

**Stop agents before removing worktrees.** A live agent holds its worktree
busy. Confirm via `ListAgents` that none of the run's agents are still running
before `git worktree remove`.
