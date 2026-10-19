import type { On, PaneOpenArgs, ProcessRunResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'

import type { SideRecord } from './herdr'
import { paneTicketRef } from './role'

// noun.tsx through the engine. The plugin loads fresh for each test, so its lock and caches start
// over. A test's own `$` carries no plugin noun and no `ui.close`, so an inline plugin (`caller`)
// makes the calls a ticket button would: `/open-ticket <json>` calls `$.ticketPanes.open(<json>)`,
// `/tickets-available` calls `$.ticketPanes.available({})`, and `/close-pane <id>` closes a pane
// with `$.ui.close`, which raises `ui.close` as the person's close does (origin `plugin` there). The
// test's hooks stand in for the world beneath: the environment, the clock, the store, the ticket
// files, herdr and the run lookup (faked by `process.run`), and the surface's panes and toasts.
// They cannot hook `ticketPanes.*`: the test's hooks load before the plugin that adds the noun.

const DIR = '/repo/.tickets'
const MAIN = 'w1:p1'
const KEY = `side:${MAIN}`
const MAIN_ENV = { HERDR_ENV: '1', HERDR_PANE_ID: MAIN, TICKETS_DIR: DIR }
const SIDE_ENV = { TICKET_PANES_TICKET: 'x-ef56', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p9', TICKETS_DIR: DIR }
const UUID = '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D'
const PANE_ID = 'ticket-panes'
const PANE_PROPS = { title: 'x-ab12', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const SURFACES = ['terminal', 'desktop'] as const
const NO_ROOM = 'the terminal is 80 columns, under the 110 a pane needs (faked)'

const AB12: SideRecord = { ticketId: 'x-ab12', paneId: 'w1:p2', paneTerminalId: 'term-2', agentName: 'tp-x-ab12' }
const CD34: SideRecord = { ticketId: 'x-cd34', paneId: 'w1:p2', paneTerminalId: 'term-2', agentName: 'tp-x-cd34' }

function ticketText(id: string, title: string): string {
  return [
    '---',
    `id: ${id}`,
    'status: open',
    'type: task',
    'priority: 2',
    '---',
    `# ${title}`,
    '',
    `What ${id} is for.`,
    '',
    '## Notes',
    '',
    '**2030-03-01T11:00:00Z**',
    '',
    `A note on ${id}.`,
    '',
  ].join('\n')
}

const FILES: Record<string, string> = {
  [`${DIR}/x-ab12.md`]: ticketText('x-ab12', 'Widen the widget'),
  [`${DIR}/x-cd34.md`]: ticketText('x-cd34', 'Narrow the widget'),
  [`${DIR}/x-ef56.md`]: ticketText('x-ef56', 'Paint the widget'),
  // A ticket file whose name a number would also read as.
  [`${DIR}/42.md`]: ticketText('42', 'Count the widgets'),
}

type FakeAgent = { name: string; status: string }
type FakePane = { terminalId: string; agent?: FakeAgent }
type World = {
  time: MockClock
  panes: Map<string, FakePane>
  // herdr commands answered otherwise, by `<group> <verb>`.
  instead: Record<string, ProcessRunResult>
  // How `agent start` fails, when it does.
  startFailure?: { code: string; message: string }
  // While set, the run lookup answers only once the clock has moved this far.
  lookupHoldMs: number
  // How `$.ui.open` answers: placed, not placed, or refused.
  openAnswer: 'placed' | 'unplaced' | 'refused'
  // Whether a close of the pane is refused beneath the plugin.
  isCloseRefused: boolean
  // Every command run, every path stat'd, each `$.ui.open` argument, each toast, each pane close
  // that reached the surface (refused or not), and each `paneTicket` written.
  runs: string[][]
  stats: string[]
  opens: PaneOpenArgs[]
  toasts: string[]
  closes: string[]
  paneTickets: unknown[]
}

function written(exitCode: number, stdout: string, stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

function answer(result: unknown): ProcessRunResult {
  return written(0, JSON.stringify({ id: 'cli', result }))
}

function refusal(code: string, message = `${code} (faked)`): ProcessRunResult {
  return written(1, '', JSON.stringify({ error: { code, message }, id: 'cli' }))
}

// herdr as the mod sees it: panes with their terminals, and the agents in them.
function herdr(w: World, args: readonly string[]): ProcessRunResult {
  const [group, verb, ...rest] = args
  const label = `${group} ${verb}`
  const instead = w.instead[label]
  if (instead !== undefined) return instead
  const info = (id: string, pane: FakePane) => ({ pane_id: id, terminal_id: pane.terminalId, agent_status: pane.agent?.status ?? 'unknown' })
  const agentNamed = (name: string | undefined) => [...w.panes].find(([, pane]) => pane.agent !== undefined && pane.agent.name === name)
  switch (label) {
    case 'pane get': {
      const pane = w.panes.get(rest[0] ?? '')
      return pane ? answer({ pane: info(rest[0] ?? '', pane) }) : refusal('pane_not_found')
    }
    case 'pane split': {
      const id = `w1:p${w.panes.size + 2}`
      const pane = { terminalId: `term-${w.panes.size + 2}` }
      w.panes.set(id, pane)
      return answer({ pane: info(id, pane) })
    }
    case 'pane close':
      return w.panes.delete(rest[0] ?? '') ? answer({ type: 'ok' }) : refusal('pane_not_found')
    case 'agent list':
      return answer({ agents: [...w.panes].flatMap(([id, pane]) => (pane.agent ? [{ ...info(id, pane), name: pane.agent.name }] : [])) })
    case 'agent get': {
      const found = agentNamed(rest[0])
      return found ? answer({ agent: { ...info(found[0], found[1]), name: rest[0] } }) : refusal('agent_not_found')
    }
    case 'agent focus':
      return agentNamed(rest[0]) ? answer({ type: 'ok' }) : refusal('agent_not_found')
    case 'agent start': {
      const [name = '', , , , paneId = ''] = rest
      const pane = w.panes.get(paneId)
      if (pane === undefined) return refusal('pane_not_found')
      if (w.startFailure !== undefined) {
        if (w.startFailure.code === 'agent_not_ready') pane.agent = { name, status: 'blocked' }
        return refusal(w.startFailure.code, w.startFailure.message)
      }
      pane.agent = { name, status: 'idle' }
      return answer({ agent: { ...info(paneId, pane), name } })
    }
    default:
      return refusal('unknown_command')
  }
}

// The world beneath the plugin, in an environment of `env`, with `store` in `$.store`.
function world(on: On, env: Record<string, string>, store: Record<string, unknown> = {}): World {
  const w = {
    panes: new Map<string, FakePane>(),
    instead: {},
    lookupHoldMs: 0,
    openAnswer: 'placed',
    isCloseRefused: false,
    runs: [],
    stats: [],
    opens: [],
    toasts: [],
    closes: [],
    paneTickets: [],
  } as Omit<World, 'time'> as World
  w.time = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  mock.store(on, store)
  on('session.root', () => ({ value: '/repo' }))
  on('fs.stat', ($, e) => {
    w.stats.push(e.path)
    const text = FILES[e.path]
    if (text === undefined) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
    return { value: { kind: 'file', size: text.length, mtimeMs: 100, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = FILES[e.path]
    return text === undefined ? { deny: `ENOENT: no such file or directory, open '${e.path}'` } : { value: text }
  })
  on('fs.exists', ($, e) => ({ value: FILES[e.path] !== undefined }))
  on('process.run', async ($, e) => {
    w.runs.push([...e.argv])
    const [command, ...args] = e.argv
    if (command === 'herdr') return { value: herdr(w, args) }
    if (command === '/usr/bin/uuidgen') return { value: written(0, `${UUID}\n`) }
    if (command === 'run-tickets-status' && args[0] === '--find-ticket') {
      if (w.lookupHoldMs > 0) await w.time.sleep(w.lookupHoldMs)
      return { value: written(1, '') } // in no running run
    }
    return { value: written(127, '', `${command}: command not found`) }
  })
  on('state.set', paneTicketRef, ($, e, next) => {
    w.paneTickets.push(e.value)
    return next(e)
  })
  on('ui.open', ($, e) => {
    w.opens.push({ ...e })
    if (w.openAnswer === 'refused') return { deny: 'no pane can open here (faked)' }
    return { value: w.openAnswer === 'placed' ? { isPlaced: true } : { isPlaced: false, reason: NO_ROOM } }
  })
  on('ui.close', ($, e) => {
    w.closes.push(e.id)
    return w.isCloseRefused ? { deny: 'the pane stays (faked)' } : { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  return w
}

// Stands in for a ticket button: its command makes the call a press would. A call that rejects
// fails the command's hook, so `$.command.run` then rejects too.
const CALLER: Plugin = {
  name: 'caller',
  register(on) {
    on('command.run', { command: 'open-ticket' }, async ($, e) => {
      await $.ticketPanes.open(JSON.parse(e.args))
      return { text: 'opened' }
    })
    on('command.run', { command: 'tickets-available' }, async $ => ({ text: JSON.stringify(await $.ticketPanes.available({})) }))
    on('command.run', { command: 'close-pane' }, async ($, e) => {
      await $.ui.close({ id: e.args })
      return { text: 'closed' }
    })
  },
}
const WITH_CALLER = { plugins: [CALLER] }

function command(name: string, args: string) {
  return { command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
}

// A press on a button for ticket `id` (any value, for the calls another plugin could make).
async function open($: Engine, id: unknown): Promise<void> {
  await $.command.run(command('open-ticket', JSON.stringify({ id })))
}

// Closes the pane `id`; a close refused beneath rejects.
async function close($: Engine, id: string = PANE_ID): Promise<void> {
  await $.command.run(command('close-pane', id))
}

function mountPane($: Engine, surface: (typeof SURFACES)[number] = 'terminal') {
  return $.ui.mount({ plugin: 'ticket-panes', surface, component: 'Pane', requestId: PANE_ID, props: PANE_PROPS })
}

type Pane = Awaited<ReturnType<typeof mountPane>>

async function texts(ui: Pane): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text)
}

// Each command run, in short: herdr's group and verb with the first argument, `uuidgen`, and
// `lookup <id>` for the run lookup.
function steps(w: World): string[] {
  return w.runs.map(argv => {
    if (argv[0] === '/usr/bin/uuidgen') return 'uuidgen'
    if (argv[0] === 'run-tickets-status') return `lookup ${argv[2]}`
    return argv.slice(1, 4).join(' ')
  })
}

function lookups(w: World): string[] {
  return steps(w).filter(step => step.startsWith('lookup '))
}

function herdrRuns(w: World): string[][] {
  return w.runs.filter(argv => argv[0] === 'herdr')
}

const PANE_OPEN = (id: string) => ({ id: PANE_ID, title: id, focus: true, closeOnEscape: true })

// ---------- available ----------

// The noun's stub rejects, so an answer is the plugin's hook.
test('AC: available({}) resolves true', WITH_CALLER, async ($, on) => {
  world(on, MAIN_ENV)
  expect(await $.command.run(command('tickets-available', ''))).toMatchObject({ text: 'true' })
})

// ---------- a main session in herdr ----------

test('AC: with no side pane, a main session in herdr launches the ticket, then looks up its run activity', WITH_CALLER, async ($, on) => {
  const w = world(on, MAIN_ENV)
  await open($, 'x-ab12')
  const s = steps(w)
  expect(s.slice(0, 4)).toEqual(['agent list', 'uuidgen', 'pane split w1:p1', 'agent start tp-x-ab12'])
  // The lookup comes once the side pane is placed, then readSide's looks.
  expect(s.slice(4)).toEqual(['lookup x-ab12', 'pane get w1:p2', 'agent get tp-x-ab12'])
  expect(w.opens).toEqual([])
  expect(w.toasts).toEqual([])
})

test('AC: a click that focuses the side agent already on the ticket looks up its run activity', WITH_CALLER, async ($, on) => {
  const w = world(on, MAIN_ENV, { [KEY]: AB12 })
  w.panes.set('w1:p2', { terminalId: 'term-2', agent: { name: 'tp-x-ab12', status: 'working' } })
  await open($, 'x-ab12')
  expect(steps(w)).toContain('agent focus tp-x-ab12')
  expect(steps(w).indexOf('lookup x-ab12')).toBeGreaterThan(steps(w).indexOf('agent focus tp-x-ab12'))
  expect(w.opens).toEqual([])
  expect(w.toasts).toEqual([])
})

test('a side agent that started on a question still gets its run activity looked up, and says it waits', WITH_CALLER, async ($, on) => {
  const w = world(on, MAIN_ENV)
  w.startFailure = { code: 'agent_not_ready', message: 'the agent is waiting on a question (faked)' }
  await open($, 'x-ab12')
  expect(lookups(w)).toEqual(['lookup x-ab12'])
  expect(w.toasts).toEqual(['x-ab12 needs an answer in the side pane'])
  expect(w.opens).toEqual([])
})

test('AC: a click that focuses an agent for the ticket outside our record looks up no run activity', WITH_CALLER, async ($, on) => {
  const w = world(on, MAIN_ENV)
  w.panes.set('w1:p7', { terminalId: 'term-7', agent: { name: 'tp-x-ab12', status: 'idle' } })
  await open($, 'x-ab12')
  expect(steps(w)).toEqual(['agent list', 'agent focus tp-x-ab12'])
  expect(w.opens).toEqual([])
  expect(w.toasts).toEqual([])
})

test('AC: a click the switch declines looks up no run activity and shows only the decline', WITH_CALLER, async ($, on) => {
  const w = world(on, MAIN_ENV, { [KEY]: CD34 })
  w.panes.set('w1:p2', { terminalId: 'term-2', agent: { name: 'tp-x-cd34', status: 'working' } })
  await open($, 'x-ab12')
  expect(lookups(w)).toEqual([])
  expect(steps(w).filter(step => /^(pane split|pane close|agent start)/.test(step))).toEqual([])
  expect(w.toasts).toEqual(['x-cd34 is still working; click again to switch anyway'])
  expect(w.opens).toEqual([])
})

// ---------- the lock ----------

test('AC: a click while an open runs, its run lookup included, toasts still opening at once and calls nothing', WITH_CALLER, async ($, on) => {
  const w = world(on, MAIN_ENV)
  w.lookupHoldMs = 5000
  const first = open($, 'x-ab12')
  await w.time.settle()
  // The first open is in syncActivity, held at its run lookup.
  expect(lookups(w)).toEqual(['lookup x-ab12'])
  const runs = w.runs.length
  const stats = w.stats.length
  await open($, 'x-cd34')
  expect(w.toasts).toEqual(['still opening x-ab12'])
  expect(w.runs).toHaveLength(runs)
  expect(w.stats).toHaveLength(stats)
  expect(w.opens).toEqual([])
  await w.time.advance(5000)
  await first
  // The first open had nothing to say, and the lock is free again: a click on the ticket shown
  // focuses its agent.
  expect(w.toasts).toEqual(['still opening x-ab12'])
  w.lookupHoldMs = 0
  await open($, 'x-ab12')
  expect(steps(w)).toContain('agent focus tp-x-ab12')
  expect(lookups(w)).toEqual(['lookup x-ab12', 'lookup x-ab12'])
  expect(w.toasts).toEqual(['still opening x-ab12'])
})

test('a click while a read-only open waits on its pane toasts still opening and opens nothing', WITH_CALLER, async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  // Ahead of the world's own `ui.open`, which answers the bare event, so this one has a matcher.
  on('ui.open', {}, async ($, e, next) => {
    await held
    return next(e)
  })
  const w = world(on, { TICKETS_DIR: DIR })
  const first = open($, 'x-ab12')
  await w.time.settle()
  await open($, 'x-cd34')
  expect(w.toasts).toEqual(['still opening x-ab12'])
  release()
  await first
  expect(w.opens).toEqual([PANE_OPEN('x-ab12')])
  expect(w.paneTickets).toEqual(['x-ab12'])
})

// The refused pane also puts back the ticket shown before it (none), so the next open replaces none.
test('an open that fails lets go of the lock: it toasts what failed, and the next click opens', WITH_CALLER, async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR })
  w.openAnswer = 'refused'
  await open($, 'x-ab12')
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^could not open x-ab12: .*no pane can open here \(faked\)$/)
  expect(w.paneTickets).toEqual(['x-ab12', null])
  w.openAnswer = 'placed'
  await open($, 'x-cd34')
  expect(w.opens).toEqual([PANE_OPEN('x-ab12'), PANE_OPEN('x-cd34')])
  expect(w.toasts).toHaveLength(1)
})

test('a refused open while the pane shows a ticket leaves it on that ticket', WITH_CALLER, async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR })
  await open($, 'x-ab12')
  const ui = await mountPane($)
  w.openAnswer = 'refused'
  await open($, 'x-cd34')
  expect(w.paneTickets).toEqual(['x-ab12', 'x-cd34', 'x-ab12'])
  expect((await texts(ui))[0]).toBe('x-ab12')
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^could not open x-cd34: /)
})

// ---------- the read-only pane ----------

test('AC: a side session opens the read-only pane, runs no herdr command, and draws the ticket expanded without toggles', WITH_CALLER, async ($, on) => {
  const w = world(on, SIDE_ENV)
  await open($, 'x-ab12')
  expect(w.opens).toStrictEqual([PANE_OPEN('x-ab12')])
  expect(w.runs).toEqual([])
  expect(w.toasts).toEqual([])
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await texts(ui)).toEqual(['x-ab12', 'open · task · P2', 'Widen the widget', '1 note'])
    expect((await ui.findAll({ type: 'Markdown' })).map(m => m.text)).toEqual(['What x-ab12 is for.', '**2030-03-01T11:00:00Z**\n\nA note on x-ab12.'])
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  }
})

test('D12: a side session opens its own ticket in the read-only pane too', WITH_CALLER, async ($, on) => {
  const w = world(on, SIDE_ENV)
  await open($, 'x-ef56')
  expect(w.opens).toStrictEqual([PANE_OPEN('x-ef56')])
  expect(w.runs).toEqual([])
  expect(w.toasts).toEqual([])
})

for (const [label, env] of [
  ['with no herdr variables', { TICKETS_DIR: DIR }],
  ['with a herdr pane but HERDR_ENV unset', { HERDR_PANE_ID: MAIN, TICKETS_DIR: DIR }],
  ['with HERDR_ENV but no pane', { HERDR_ENV: '1', TICKETS_DIR: DIR }],
] as const) {
  test(`AC: a session not in herdr (${label}) opens the read-only pane and runs no command`, WITH_CALLER, async ($, on) => {
    const w = world(on, env)
    await open($, 'x-ab12')
    expect(w.opens).toStrictEqual([PANE_OPEN('x-ab12')])
    expect(w.runs).toEqual([])
    // No side pane was tried, so none failed.
    expect(w.toasts).toEqual([])
    expect(w.paneTickets).toEqual(['x-ab12'])
    expect(await texts(await mountPane($))).toContain('Widen the widget')
  })
}

test('AC: a pane with no room is still opened, and the click says so', WITH_CALLER, async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR })
  w.openAnswer = 'unplaced'
  await open($, 'x-ab12')
  expect(w.opens).toStrictEqual([PANE_OPEN('x-ab12')])
  expect(w.toasts).toEqual(['x-ab12: no room to show the ticket pane'])
})

test('AC: opening another ticket while the pane shows one replaces it and says so', WITH_CALLER, async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR })
  await open($, 'x-ab12')
  const ui = await mountPane($)
  expect((await texts(ui))[0]).toBe('x-ab12')
  await open($, 'x-cd34')
  expect((await texts(ui)).slice(0, 3)).toEqual(['x-cd34', 'open · task · P2', 'Narrow the widget'])
  expect(w.toasts).toEqual(['Showing x-cd34 (replaced x-ab12)'])
  expect(w.opens).toEqual([PANE_OPEN('x-ab12'), PANE_OPEN('x-cd34')])
})

test('opening the ticket the pane shows again replaces nothing', WITH_CALLER, async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR })
  await open($, 'x-ab12')
  await open($, 'x-ab12')
  expect(w.toasts).toEqual([])
  expect(w.opens).toEqual([PANE_OPEN('x-ab12'), PANE_OPEN('x-ab12')])
})

// The pane shows x-ab12 when it closes, so only the close keeps the toast away from x-cd34.
test('AC: once the pane is closed it shows no ticket, and opening x-cd34 replaces none', WITH_CALLER, async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR })
  await open($, 'x-ab12')
  await close($)
  expect(w.closes).toEqual([PANE_ID])
  expect(w.paneTickets).toEqual(['x-ab12', null])
  expect(await texts(await mountPane($))).toEqual(['no ticket'])
  await open($, 'x-cd34')
  expect(w.toasts).toEqual([])
  expect(w.opens).toEqual([PANE_OPEN('x-ab12'), PANE_OPEN('x-cd34')])
  // Open again, the pane replaces its ticket as before.
  await open($, 'x-ab12')
  expect(w.toasts).toEqual(['Showing x-ab12 (replaced x-cd34)'])
})

test('a close refused beneath the plugin leaves the pane on its ticket', WITH_CALLER, async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR })
  await open($, 'x-ab12')
  w.isCloseRefused = true
  await expect(close($)).rejects.toThrow()
  expect(w.closes).toEqual([PANE_ID])
  expect(w.paneTickets).toEqual(['x-ab12'])
  expect((await texts(await mountPane($)))[0]).toBe('x-ab12')
  await open($, 'x-cd34')
  expect(w.toasts).toEqual(['Showing x-cd34 (replaced x-ab12)'])
})

test('a close of another pane leaves the ticket pane alone', WITH_CALLER, async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR })
  await open($, 'x-ab12')
  await close($, 'other-pane')
  expect(w.closes).toEqual(['other-pane'])
  expect(w.paneTickets).toEqual(['x-ab12'])
  await open($, 'x-cd34')
  expect(w.toasts).toEqual(['Showing x-cd34 (replaced x-ab12)'])
})

// ---------- failures ----------

test('AC: a side pane that fails toasts what failed and opens the read-only pane (D13)', WITH_CALLER, async ($, on) => {
  const w = world(on, MAIN_ENV)
  w.instead['pane split'] = refusal('server_error', 'herdr could not split (faked)')
  await open($, 'x-ab12')
  expect(w.toasts).toEqual(['no side pane for x-ab12: pane split: herdr could not split (faked)'])
  expect(w.opens).toStrictEqual([PANE_OPEN('x-ab12')])
  expect(lookups(w)).toEqual([])
  expect(await texts(await mountPane($))).toContain('Widen the widget')
})

test('a side pane failure and a pane with no room show as one toast, joined in order', WITH_CALLER, async ($, on) => {
  const w = world(on, MAIN_ENV)
  w.instead['agent list'] = refusal('server_error', 'herdr is not answering (faked)')
  w.openAnswer = 'unplaced'
  await open($, 'x-ab12')
  expect(w.toasts).toEqual(['no side pane for x-ab12: agent list: herdr is not answering (faked); x-ab12: no room to show the ticket pane'])
  expect(steps(w)).toEqual(['agent list'])
})

test('a failure that is no SidePaneError is named by its first line, and the read-only pane opens', WITH_CALLER, async ($, on) => {
  // Ahead of the world's store, which answers the bare event, so this one has a matcher.
  on('store.get', {}, () => ({ deny: 'the store is locked (faked)\nand a second line' }))
  const w = world(on, MAIN_ENV)
  await open($, 'x-ab12')
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^no side pane for x-ab12: .*the store is locked \(faked\)$/)
  expect(w.runs).toEqual([])
  expect(w.opens).toStrictEqual([PANE_OPEN('x-ab12')])
})

for (const [label, id] of [
  ['an id with shell in it', 'x-ab12; rm'],
  ['an id with a /', '../x-ab12'],
  ['an id with no ticket file', 'x-zz99'],
] as const) {
  test(`AC: ${label} toasts not a ticket and does nothing else`, WITH_CALLER, async ($, on) => {
    const w = world(on, MAIN_ENV)
    await open($, id)
    expect(w.toasts).toEqual([`not a ticket: ${id}`])
    expect(w.runs).toEqual([])
    expect(w.opens).toEqual([])
    expect(w.paneTickets).toEqual([])
    // Only the ticket's own file is looked for, and only for an id a tk id could be.
    expect(w.stats).toEqual(id === 'x-zz99' ? [`${DIR}/x-zz99.md`] : [])
  })
}

test('an id that is not a string is not a ticket, even when a file has its text for a name', WITH_CALLER, async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR })
  await open($, 42)
  expect(w.toasts).toEqual(['not a ticket: 42'])
  expect(w.opens).toEqual([])
  expect(w.stats).toEqual([])
  // The same name as a string is the ticket.
  await open($, '42')
  expect(w.opens).toStrictEqual([PANE_OPEN('42')])
})
