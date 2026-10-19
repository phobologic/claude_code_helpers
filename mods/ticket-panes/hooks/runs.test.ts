import type { EngineInterface, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { unfinishedRunFor } from './runs'

// unfinishedRunFor runs against a stand-in for `$`, as core.test.ts's rule modules do: no hook
// calls it yet (the guard and the activity pane will), and the test's own `$` takes each call's
// input whole (`$.process.run({ argv })`), not a plugin's arguments. The stand-in has just
// `session.root` and `process.run`, keeps what it was asked, and answers as the engine does: the
// child's exit, whatever its code, or a rejection when the command cannot start or is still
// running at the timeout. No real run-tickets-status runs (K3).

const ROOT = '/repo/.worktrees/w1'
const LOOKUP = ['run-tickets-status', '--find-ticket', 'x-ab12']
// What run-tickets-status prints when a running run holds the ticket.
const FOUND = '{"run_id": "wf_1", "state": "running"}\n'
const UNEXPECTED = 'run-tickets-status --find-ticket: unexpected output'
const FAILED = 'run-tickets-status --find-ticket failed'

// How the engine of this build (2.1.303) rejects, as a throwaway mod read it: a command not on
// PATH, and one still running at the timeout.
const NOT_FOUND = 'ticket-panes: $.process.run(run-tickets-status) failed to start: ENOENT: Executable not found in $PATH: "run-tickets-status"'
const TIMED_OUT = 'ticket-panes: $.process.run(run-tickets-status) aborted: still running after 20000ms'

type World = {
  // How the child exits: 0, having printed nothing, when not given.
  exit?: { code: number; stdout?: string; stderr?: string }
  // What `$.process.run` rejects with, the child never having run to its end.
  runRejection?: unknown
  // What `$.session.root()` rejects with.
  rootRejection?: unknown
}

// An error as the engine makes one.
function hooksError(message: string): Error {
  const err = new Error(message)
  err.name = 'HooksError'
  return err
}

function fake(world: World = {}) {
  const calls: { argv: string[]; init: ProcessRunInit | undefined }[] = []
  const $ = {
    session: {
      root: async () => {
        if (world.rootRejection !== undefined) throw world.rootRejection
        return ROOT
      },
    },
    process: {
      run: async (argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> => {
        calls.push({ argv: [...argv], init })
        if (world.runRejection !== undefined) throw world.runRejection
        const exit = world.exit ?? { code: 0 }
        return { exitCode: exit.code, stdout: exit.stdout ?? '', stderr: exit.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
  }
  return { $: $ as unknown as EngineInterface, calls }
}

function lookUp(world: World) {
  return unfinishedRunFor(fake(world).$, 'x-ab12')
}

test('AC R2: a running run that holds the ticket gives its run id; the lookup runs in the session root, with 20 s to finish', async () => {
  const found = fake({ exit: { code: 0, stdout: FOUND } })
  expect(await unfinishedRunFor(found.$, 'x-ab12')).toStrictEqual({ runId: 'wf_1' })
  expect(found.calls).toStrictEqual([{ argv: LOOKUP, init: { cwd: ROOT, timeoutMs: 20_000 } }])
})

test('a run id of the workflow\'s shape, with letters, digits, `_` and `-`, is the answer', async () => {
  for (const runId of ['wf_82c81840-05c', 'A9-_z', '_1', '9a', 'wF-1'])
    expect(await lookUp({ exit: { code: 0, stdout: `{"run_id": "${runId}", "state": "running"}` } })).toStrictEqual({ runId })
})

test('fields beside the run id and its state are passed over', async () => {
  expect(await lookUp({ exit: { code: 0, stdout: '{"run_id": "wf_2", "state": "running", "epic": "x-cd34"}' } })).toStrictEqual({ runId: 'wf_2' })
})

test('AC: exit 1, no running run holds the ticket, is none', async () => {
  expect(await lookUp({ exit: { code: 1 } })).toStrictEqual({ none: true })
  // Whatever else it printed: an exit of 1 is the answer.
  expect(await lookUp({ exit: { code: 1, stderr: 'run-tickets-status: no run x-ab12\n' } })).toStrictEqual({ none: true })
})

test('AC: exit 2 gives the reason on its stderr\'s first line as the error', async () => {
  expect(await lookUp({ exit: { code: 2, stderr: 'not a git repository\n' } })).toStrictEqual({ error: 'not a git repository' })
  // A usage error: the problem first, the usage after it.
  const usage = 'run-tickets-status: --find-ticket needs a value\nUsage: run-tickets-status --find-ticket <id>\n'
  expect(await lookUp({ exit: { code: 2, stderr: usage } })).toStrictEqual({ error: 'run-tickets-status: --find-ticket needs a value' })
  // Blank lines, and the space around the reason, are passed over.
  const padded = '\n   \n  run-tickets-status: ValueError: cannot read run-1.json \r\n'
  expect(await lookUp({ exit: { code: 2, stderr: padded } })).toStrictEqual({ error: 'run-tickets-status: ValueError: cannot read run-1.json' })
  // Nothing on stderr: the exit is what names the failure.
  expect(await lookUp({ exit: { code: 2 } })).toStrictEqual({ error: 'run-tickets-status --find-ticket exited 2' })
})

test('AC: a missing command, or a lookup still running at the timeout, is an error with the engine\'s reason', async () => {
  expect(await lookUp({ runRejection: hooksError(NOT_FOUND) })).toStrictEqual({ error: NOT_FOUND })
  expect(await lookUp({ runRejection: hooksError(TIMED_OUT) })).toStrictEqual({ error: TIMED_OUT })
})

test('AC: exit 0 with output other than the run\'s JSON is an error', async () => {
  const outputs = [
    'running wf_1',
    '',
    'null',
    '7',
    '"wf_1"',
    '[]',
    '{}',
    '{"run_id": "wf_1"}',
    '{"run_id": "wf_1", "state": "finished"}',
    '{"run_id": "", "state": "running"}',
    '{"run_id": 7, "state": "running"}',
    '{"run_id": "wf_*[c;echo x]", "state": "running"}',
    '{"run_id": "wf_1`id`", "state": "running"}',
    '{"run_id": "wf_1 $(id)", "state": "running"}',
    '{"run_id": "--list", "state": "running"}',
    '{"run_id": "-wf_1", "state": "running"}',
    '{"run_id": "wf_1\\n", "state": "running"}',
    '{"run_id": "\\nwf_1", "state": "running"}',
    '{"run_id": "wf.1", "state": "running"}',
    '{"state": "running"}',
    `${FOUND}${FOUND}`,
  ]
  const answers: [string, unknown][] = []
  for (const stdout of outputs) answers.push([stdout, await lookUp({ exit: { code: 0, stdout } })])
  expect(answers).toStrictEqual(outputs.map(stdout => [stdout, { error: UNEXPECTED }]))
})

// One character at a time, so that letting any single shell character into the id is caught,
// not hidden by another bad character in the same id.
test('a run id with any one character outside letters, digits, `_` and `-` is an error', async () => {
  const chars = ['\t', ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))].filter(c => !/[A-Za-z0-9_-]/.test(c))
  const answers: [string, unknown][] = []
  for (const c of chars) answers.push([c, await lookUp({ exit: { code: 0, stdout: JSON.stringify({ run_id: `wf_1${c}x`, state: 'running' }) } })])
  expect(answers).toStrictEqual(chars.map(c => [c, { error: UNEXPECTED }]))
})

test('any other exit names its code, and stderr\'s first line when there is one', async () => {
  expect(await lookUp({ exit: { code: 3, stderr: 'boom\nmore\n' } })).toStrictEqual({ error: 'run-tickets-status --find-ticket exited 3: boom' })
  expect(await lookUp({ exit: { code: 127 } })).toStrictEqual({ error: 'run-tickets-status --find-ticket exited 127' })
})

test('AC: it never throws; whatever rejects, the answer is an error', async () => {
  // The session root can't be read: no lookup runs.
  const noRoot = fake({ rootRejection: hooksError('ticket-panes: $.session.root failed') })
  expect(await unfinishedRunFor(noRoot.$, 'x-ab12')).toStrictEqual({ error: 'ticket-panes: $.session.root failed' })
  expect(noRoot.calls).toStrictEqual([])
  // The first line of a message; a rejection that is not an Error, by its text.
  expect(await lookUp({ runRejection: hooksError(`${TIMED_OUT}\n    at run (engine)`) })).toStrictEqual({ error: TIMED_OUT })
  expect(await lookUp({ runRejection: 'refused' })).toStrictEqual({ error: 'refused' })
  // Nothing to tell, or a rejection that can't be put into words: the lookup failed.
  expect(await lookUp({ runRejection: hooksError('') })).toStrictEqual({ error: FAILED })
  const unprintable = {
    toString(): string {
      throw new Error('no text')
    },
  }
  expect(await lookUp({ runRejection: unprintable })).toStrictEqual({ error: FAILED })
})
