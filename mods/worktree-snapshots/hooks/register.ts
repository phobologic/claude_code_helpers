import type { EngineInterface, Register } from 'claude-code'

// Worktree snapshots: before each Bash command, bin/snapshot.py saves the session's git
// checkout (tracked files as they are on disk, and untracked files that are not ignored)
// as a reflog entry on refs/snapshots/bash, so work a command destroys can be restored
// with `git restore --source=refs/snapshots/bash@{N} -- <path>`. Entries expire after 3
// days. A snapshot that fails never stops the command; the first failure in a session
// is shown as a toast.

export const TIMEOUT_MS = 30_000

async function snapshot($: EngineInterface, command: string): Promise<string | undefined> {
  try {
    const run = await $.process.run(['python3', '-I', `${$.plugin.root}/bin/snapshot.py`, command], {
      cwd: await $.session.cwd(),
      timeoutMs: TIMEOUT_MS,
    })
    return run.exitCode === 0 ? undefined : run.stderr.trim() || `snapshot.py exited ${run.exitCode}`
  } catch (error) {
    return String((error as Error)?.message ?? error)
  }
}

export const register: Register = (on) => {
  let warned = false

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const failure = await snapshot($, String(e.command ?? ''))
    if (failure !== undefined && !warned) {
      warned = true
      try {
        await $.ui.toast(`worktree-snapshots: no snapshot before this command (${failure})`)
      } catch {
        // A surface that can't show toasts must not stop the command.
      }
    }
    return next(e)
  })
}
