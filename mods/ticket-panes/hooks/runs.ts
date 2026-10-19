import type { EngineInterface, ProcessRunResult } from 'claude-code'

// R2: whether a /run-tickets run is working on a ticket. `run-tickets-status --find-ticket <id>`
// decides it (a run of the repo whose state is `running` holds the ticket with an outcome other
// than `merged`), and this module is the mod's only caller of it: the guard (3.3) and the
// activity pane (2.5) both ask here, and neither decides it on its own.

// The lookup's answer: the run working on the ticket, none, or what kept the lookup from
// telling. A caller that decides (the guard) takes an error as not in a run; the activity pane
// shows it (D17).
export type RunLookup = { runId: string } | { none: true } | { error: string }

// How long the lookup may run before the engine stops it.
const LOOKUP_TIMEOUT_MS = 20_000

const FIND = 'run-tickets-status --find-ticket'

// A run id as the workflow gives one (`wf_<hex>-<hex>`): letters, digits, `_` and `-`, not
// starting with `-`. The id comes from repo files through the lookup, and callers put it in
// commands (2.5's `herdr pane run`), so an id with anything else in it, which could read as a
// flag or as shell, is not an answer.
const RUN_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/

// The lookup for ticket `id`, run in the session's root (from a worktree, run-tickets-status
// finds the repo above it). It never throws: a command that is missing or still running at the
// timeout, an exit other than 0 or 1, or output other than the run's JSON is an `error` that
// names what failed.
export async function unfinishedRunFor($: EngineInterface, id: string): Promise<RunLookup> {
  try {
    const cwd = await $.session.root()
    return lookupFrom(await $.process.run(['run-tickets-status', '--find-ticket', id], { cwd, timeoutMs: LOOKUP_TIMEOUT_MS }))
  } catch (err) {
    return { error: reasonOf(err) }
  }
}

// What the lookup's exit means (bin/run-tickets-status): 0, a run holds the ticket, with
// `{"run_id": ..., "state": "running"}` on stdout; 1, none does; 2, it could not tell, with the
// reason on stderr's first line.
function lookupFrom(out: ProcessRunResult): RunLookup {
  if (out.exitCode === 1) return { none: true }
  if (out.exitCode !== 0) return { error: exitError(out.exitCode, out.stderr) }
  const runId = runIdIn(out.stdout)
  return runId === undefined ? { error: `${FIND}: unexpected output` } : { runId }
}

// The error for an exit that is not an answer. For 2, the reason the lookup printed, which names
// the failure itself (`run-tickets-status: not inside a git repository`); for any other code, or
// a 2 that printed nothing, the code, and stderr's first line when there is one.
function exitError(code: number, stderr: string): string {
  const reason = firstLine(stderr)
  if (code === 2 && reason !== undefined) return reason
  return reason === undefined ? `${FIND} exited ${code}` : `${FIND} exited ${code}: ${reason}`
}

// The run id in the lookup's answer, or undefined when stdout is not that answer: the JSON of an
// object whose `run_id` is a string of RUN_ID's shape and whose `state` is `running`. Other
// fields are passed over.
function runIdIn(stdout: string): string | undefined {
  let answer: unknown
  try {
    answer = JSON.parse(stdout)
  } catch {
    return undefined // not JSON
  }
  if (typeof answer !== 'object' || answer === null) return undefined
  const { run_id: runId, state } = answer as Record<string, unknown>
  return typeof runId === 'string' && RUN_ID.test(runId) && state === 'running' ? runId : undefined
}

// The first line of `text` with anything on it, trimmed; undefined when there is none.
function firstLine(text: string): string | undefined {
  return text
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '')
}

// What a rejected lookup says failed: the first line of the error's message, where the engine
// names the command and why (`failed to start: ENOENT: ...`, `aborted: still running after
// 20000ms`). It does not throw, whatever was thrown.
function reasonOf(err: unknown): string {
  try {
    return firstLine(err instanceof Error ? err.message : String(err)) ?? `${FIND} failed`
  } catch {
    return `${FIND} failed`
  }
}
