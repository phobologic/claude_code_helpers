import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, Plugin } from 'claude-code/testing'

import { agentLines, clock, duration, parseOffset, runLines, summarize, ticketLine } from './register'
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

// ---------- ticket rows that open tickets ----------

test('a ticket line is its id and the rest, which the run lines pad between', () => {
  const s = summarize(REPORT, T0)
  expect(ticketLine(s.open[0]!, 120)).toEqual({ id: 'x-2', rest: '  reviewing (round 2)  started 16:47  running 5m00s', isDim: false })
  expect(ticketLine(s.open[1]!, 120)).toEqual({ id: 'x-10', rest: '  queued for a worktree slot', isDim: true })
  // The times show only for a step that is running and says when it started.
  expect(ticketLine({ id: 'x-3', status: 'blocked', isActive: false, startedClock: '16:30' }, 0).rest).toBe('  blocked')
  expect(ticketLine({ id: 'x-4', status: 'implementing', isActive: true, runningFor: 30 }, 0).rest).toBe('  implementing')
})

// Stands in for the ticket-panes mod: it puts `$.ticketPanes` on the engine interface and
// leaves its calls to the test's hooks beneath (`ticketPanes` below). An inline plugin
// closes over nothing of the test file, so it can't record them itself.
const TICKET_PANES: Plugin = {
  name: 'ticket-panes',
  register(on) {
    on('engine.create', async ($, e, next) => ({
      ...(await next(e)),
      ticketPanes: { open: async () => {}, available: async () => true as const },
    }))
  },
}

// Answers ticket-panes' calls, counting the probes and keeping the ids opened. A failure
// is a deny, which rejects the call; a hook that throws is skipped instead, and the
// stub beneath it answers.
function ticketPanes(on: On, { isAvailable = true, failsOpen = false } = {}) {
  const seen = { asked: 0, opened: [] as string[] }
  on('ticketPanes.available', () => {
    seen.asked += 1
    return isAvailable ? { value: true as const } : { deny: 'ticket-panes failed' }
  })
  on('ticketPanes.open', ($, e) => {
    seen.opened.push(e.id)
    return failsOpen ? { deny: 'could not open' } : { value: undefined }
  })
  return seen
}

// Every Text the band drew, top to bottom, with whether it is dim.
async function texts<P extends 'terminal' | 'desktop'>(ui: Mounted<P, 'AbovePrompt'>) {
  return (await ui.findAll({ type: 'Text' })).map(t => [t.text, t.props.dimColor === true])
}

// The status is read and drawn at T0 + 2m, when x-2's review had run 3 minutes.
const SHOWN = T0 + 2 * MIN
const TEXT_ROWS = runLines(summarize(REPORT, SHOWN), SHOWN).map(l => [l.text, l.isDim === true])

test('with ticket-panes loaded, each unmerged ticket id is a button that opens the ticket', { plugins: [TICKET_PANES] }, async ($, on) => {
  mock.clock(on, { now: SHOWN })
  engine(on, { exitCode: 0, stdout: JSON.stringify(REPORT) }, [])
  const seen = ticketPanes(on)
  await $.command.run(COMMAND)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(b => [b.key, b.props.label, b.props.dimColor])).toEqual([
      ['ticket-x-2', 'x-2', false],
      ['ticket-x-10', 'x-10', true],
    ])
    // The rest of each row follows its button, padded to the widest id; the band beneath
    // draws under this one.
    expect(await texts(ui)).toEqual([
      ['run-tickets wf_test-1  running 10m  merged 1/3  epic/x-1', false],
      ['   reviewing (round 2)  started 16:47  running 3m00s', false],
      ['  queued for a worktree slot', true],
      ['engine band', false],
    ])
    await ui.press({ key: 'ticket-x-2' })
    expect(seen.opened).toEqual(['x-2'])
    seen.opened.length = 0
    await ui.unmount()
  }
})

test('without ticket-panes the band draws the text rows it always did, above the band beneath', async ($, on) => {
  mock.clock(on, { now: SHOWN })
  engine(on, { exitCode: 0, stdout: JSON.stringify(REPORT) }, [])
  await $.command.run(COMMAND)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    expect(await texts(ui)).toEqual([...TEXT_ROWS, ['engine band', false]])
    await ui.unmount()
  }
})

test('if ticket-panes fails to answer, the band draws the text rows', { plugins: [TICKET_PANES] }, async ($, on) => {
  mock.clock(on, { now: SHOWN })
  engine(on, { exitCode: 0, stdout: JSON.stringify(REPORT) }, [])
  const seen = ticketPanes(on, { isAvailable: false })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(seen.asked).toBe(1)
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  expect(await texts(ui)).toEqual([...TEXT_ROWS, ['engine band', false]])
})

test('ticket-panes is asked once at session start, and not again by the draws', { plugins: [TICKET_PANES] }, async ($, on) => {
  mock.clock(on, { now: SHOWN })
  engine(on, { exitCode: 0, stdout: JSON.stringify(REPORT) }, [])
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const seen = ticketPanes(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(seen.asked).toBe(1)
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.redraw()
  expect(seen.asked).toBe(1)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
})

// A reload runs `register` afresh and raises no session start: a test that raises none is one.
test('after a reload the first draw asks ticket-panes, and later draws do not', { plugins: [TICKET_PANES] }, async ($, on) => {
  mock.clock(on, { now: SHOWN })
  engine(on, { exitCode: 0, stdout: JSON.stringify(REPORT) }, [])
  const seen = ticketPanes(on)
  await $.command.run(COMMAND)
  expect(seen.asked).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(seen.asked).toBe(1)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
  await ui.redraw()
  expect(seen.asked).toBe(1)
})

test('a press whose open fails leaves the band as it was', { plugins: [TICKET_PANES] }, async ($, on) => {
  mock.clock(on, { now: SHOWN })
  engine(on, { exitCode: 0, stdout: JSON.stringify(REPORT) }, [])
  const seen = ticketPanes(on, { failsOpen: true })
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'ticket-x-10' })
  expect(seen.opened).toEqual(['x-10'])
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
})

test('a narrow band cuts the rest of a ticket row to the room its button leaves', { plugins: [TICKET_PANES] }, async ($, on) => {
  mock.clock(on, { now: SHOWN })
  engine(on, { exitCode: 0, stdout: JSON.stringify(REPORT) }, [])
  ticketPanes(on)
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 30 } })
  // 30 columns less the indent and `[ id ]`, the padding after the id counted in.
  expect((await texts(ui)).map(([text]) => text)).toEqual([
    'run-tickets wf_test-1  running',
    '   reviewing (round 2',
    '  queued for a workt',
    'engine band',
  ])
})

test('an id too long for the band leaves no room for the rest of its row', { plugins: [TICKET_PANES] }, async ($, on) => {
  mock.clock(on, { now: SHOWN })
  const report: Report = { ...REPORT, tickets: [{ id: 'x-0123456789abc', status: 'queued', outcome: null }] }
  engine(on, { exitCode: 0, stdout: JSON.stringify(report) }, [])
  ticketPanes(on)
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 20 } })
  expect(await ui.find({ type: 'Button', key: 'ticket-x-0123456789abc' })).toBeDefined()
  expect((await texts(ui)).map(([text]) => text)).toEqual(['run-tickets wf_test-', '', 'engine band'])
})

test('with ticket-panes loaded the band still shows the session\'s running agents under the run', { plugins: [TICKET_PANES] }, async ($, on) => {
  const time = mock.clock(on, { now: SHOWN })
  engine(on, { exitCode: 0, stdout: JSON.stringify(REPORT) }, [])
  ticketPanes(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  // The session's first workflow agent shows the band and reads the run.
  await $.agent.spawn({
    tool_use_id: 't1', prompt: 'go', description: 'impl x-10', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: true, fork: false,
    workflow: { runId: 'wf_test-1', agentIndex: 1 },
  })
  await time.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).map(([text]) => text)).toEqual([
    'run-tickets wf_test-1  running 10m  merged 1/3  epic/x-1',
    '   reviewing (round 2)  started 16:47  running 3m00s',
    '  queued for a worktree slot',
    'agents  1 running, 0 finished',
    '  23:52  impl x-10  running 0s',
    'engine band',
  ])
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
})
