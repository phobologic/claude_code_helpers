import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { agentLines, clock, duration, parseOffset, runLines, summarize } from './register'
import type { Report } from './register'

const MIN = 60_000
// 2030-03-01 23:50 UTC
const T0 = 1_898_639_400_000

test('clock times follow the UTC offset and wrap past midnight', () => {
  expect(parseOffset('-0700\n')).toBe(-420)
  expect(parseOffset('+0530')).toBe(330)
  expect(parseOffset('garbage')).toBe(0)
  expect(clock(T0, 0)).toBe('23:50')
  expect(clock(T0 + 15 * MIN, 0)).toBe('00:05')
  expect(clock(T0, -420)).toBe('16:50')
})

test('durations read like /workflows under ten minutes and in minutes after', () => {
  expect(duration(45)).toBe('45s')
  expect(duration(148)).toBe('2m28s')
  expect(duration(18 * 60 + 10)).toBe('18m')
  expect(duration(65 * 60)).toBe('1h05m')
  expect(duration(-3)).toBe('0s')
})

const REPORT: Report = {
  run_id: 'wf_test-1',
  state: 'running',
  integration_branch: 'epic/x-1',
  duration_seconds: 600,
  merge_halted: null,
  tickets: [
    { id: 'x-1', status: 'merged abc123', outcome: 'merged', steps: [{ step: 'merge', round: 1, started: '2030-03-01T16:40:00-07:00' }] },
    { id: 'x-2', status: 'reviewing (round 2)', outcome: null, timing: { running_for: 180 },
      steps: [{ step: 'impl', round: 1, started: '2030-03-01T16:30:00-07:00' }, { step: 'review', round: 2, started: '2030-03-01T16:47:00-07:00' }] },
    { id: 'x-10', status: 'queued for a worktree slot', outcome: null, timing: null, steps: [] },
  ],
}

test('the run summary keeps only unmerged tickets, with the running step and its local start', () => {
  const s = summarize(REPORT, T0)
  expect(s.merged).toBe(1)
  expect(s.total).toBe(3)
  expect(s.open.map(t => t.id)).toEqual(['x-2', 'x-10'])
  expect(s.open[0]).toEqual({ id: 'x-2', status: 'reviewing (round 2)', isActive: true, step: 'review r2', startedClock: '16:47', runningFor: 180 })
  expect(s.open[1]?.isActive).toBe(false)
})

test('run lines move a running run and its running step on from when the status was read', () => {
  const lines = runLines(summarize(REPORT, T0), T0 + 2 * MIN)
  expect(lines[0]?.text).toBe('run-tickets wf_test-1  running 12m  merged 1/3  epic/x-1')
  expect(lines[1]?.text).toBe('  x-2   reviewing (round 2)  started 16:47  running 5m00s')
  expect(lines[2]).toEqual({ text: '  x-10  queued for a worktree slot', isDim: true })
  const finished = runLines(summarize({ ...REPORT, state: 'finished' }, T0), T0 + 30 * MIN)
  expect(finished[0]?.text).toContain('finished 10m')
})

test('agent lines count every agent and list the running ones, newest first', () => {
  const lines = agentLines([
    { key: 'a', runId: 'wf_1', label: 'impl x-2', startedAt: T0, agentId: 'a1', endedAt: T0 + 148_000 },
    { key: 'b', runId: 'wf_1', label: 'impl x-3', startedAt: T0 + MIN, agentId: 'a2', endedAt: T0 + 2 * MIN, isAborted: true },
    { key: 'c', runId: 'wf_1', label: 'review x-2 r2', startedAt: T0 + 3 * MIN },
    { key: 'd', runId: 'wf_1', label: 'impl x-4', startedAt: T0 + 4 * MIN },
  ], T0 + 5 * MIN, 0)
  expect(lines.map(l => l.text)).toEqual([
    'agents  2 running, 2 finished (1 stopped)',
    '  23:54  impl x-4       running 1m00s',
    '  23:53  review x-2 r2  running 2m00s',
  ])
  expect(lines[0]?.isDim).toBe(false)
  const done = agentLines([{ key: 'a', runId: 'wf_1', label: 'impl x-2', startedAt: T0, endedAt: T0 + MIN }], T0 + 5 * MIN, 0)
  expect(done).toEqual([{ text: 'agents  0 running, 1 finished', isDim: true }])
})

const BAND = {
  plugin: 'workflow-monitor', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

// /workflow-monitor typed at the prompt.
const COMMAND = {
  command: 'workflow-monitor', args: '', origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

// Stands in for the engine: draws its own band beneath the mod's, and answers
// run-tickets-status with `status`.
function engine(on: On, status: { exitCode: number; stdout: string }, ran: string[][]) {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    return { value: { ...status, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('the band draws nothing until shown, and the command toggles it', async ($, on) => {
  mock.clock(on, { now: T0 })
  engine(on, { exitCode: 1, stdout: '' }, [])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    expect(await $.command.run(COMMAND)).toEqual({ text: 'Workflow monitor shown above the prompt. /workflow-monitor hides it.' })
    expect(await ui.find({ type: 'Text', text: /No workflow agents/ })).toBeDefined()
    expect(await $.command.run(COMMAND)).toEqual({ text: 'Workflow monitor hidden. /workflow-monitor shows it again.' })
    expect(await ui.find({ type: 'Text', text: /No workflow agents/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band yields to a survey', async ($, on) => {
  mock.clock(on, { now: T0 })
  engine(on, { exitCode: 1, stdout: '' }, [])
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: /No workflow agents/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('the command shows the band with the run read from run-tickets-status', async ($, on) => {
  mock.clock(on, { now: T0 + 2 * MIN })
  const ran: string[][] = []
  engine(on, { exitCode: 0, stdout: JSON.stringify(REPORT) }, ran)
  // The status is read at T0 + 2m, when x-2's review had run 3 minutes.
  await $.command.run(COMMAND)
  expect(ran).toEqual([['run-tickets-status', '--json']])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'run-tickets wf_test-1  running 10m  merged 1/3  epic/x-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /x-2 +reviewing \(round 2\) +started 16:47 +running 3m00s/ })).toBeDefined()
    // A run and no agents in this session: no agent section, and no empty-session line.
    expect(await ui.find({ type: 'Text', text: /agents|No workflow agents/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a repo with no run shows no run section', async ($, on) => {
  mock.clock(on, { now: T0 })
  engine(on, { exitCode: 1, stdout: '' }, [])
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /run-tickets/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No workflow agents/ })).toBeDefined()
})
