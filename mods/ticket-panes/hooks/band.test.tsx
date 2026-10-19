import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { bandModeRef, roleRef, ticketVersionRef } from './role'
import type { Role } from './role'
import { VIEW_KEYS } from './view'

// band.ts through the engine: the plugin loads fresh for each test, so each starts as a reload
// would leave it (no session.start unless the test raises one). The test's hooks stand in for the
// world beneath the plugin: the environment, the clock, the ticket's file, the session, and a band
// of the hooks beneath (another mod's, say), which the side band draws above.

const DIR = '/repo/.tickets'
const FILE = `${DIR}/x-ab12.md`
const SIDE_ENV = { TICKET_PANES_TICKET: 'x-ab12', TICKETS_DIR: DIR }
const MAIN_ENV = { TICKETS_DIR: DIR, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }
const V1 = '---\nid: x-ab12\nstatus: open\ntype: task\npriority: 2\n---\n# Widen the widget\n\nThe first text.\n'
const V2 = '---\nid: x-ab12\nstatus: in_progress\ntype: task\npriority: 2\n---\n# Narrow the widget\n\nThe second text.\n'
const BENEATH = 'band beneath'

const BAND = {
  plugin: 'ticket-panes',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const
const ORIGIN = { kind: 'composer' } as const

type Ticket = { mtimeMs: number; text: string }
type World = {
  time: MockClock
  // The ticket's file, or undefined while it is gone.
  ticket: Ticket | undefined
  // Whether `$.env.get` answers; while not, it refuses every variable.
  isEnvReadable: boolean
  // Every path the plugin stat'd.
  stats: string[]
  // How many periods of `$.clock.every` timers the plugin asked for: a timer asks for its first
  // as it starts, and for the next as each one ends.
  periods: number
  // Every `bandMode` and `ticketVersion` the plugin wrote.
  modes: unknown[]
  versions: unknown[]
  // How many `ticketVersion` writes to refuse before taking them.
  versionRefusals: number
  // The prompts that reached the engine, by text.
  prompts: string[]
  logs: string[]
}

// Answers what the plugin asks of the world beneath it. Only the ticket's file exists: any other
// path, the tickets folders a walk looks for included, is missing. With `kept`, the environment
// refuses TICKET_PANES_TICKET, so the role is the one `$.state` kept (role.ts's fallback).
function world(on: On, env: Record<string, string>, kept?: Role): World {
  const w = {
    ticket: { mtimeMs: 100, text: V1 },
    isEnvReadable: true,
    stats: [],
    periods: 0,
    modes: [],
    versions: [],
    versionRefusals: 0,
    prompts: [],
    logs: [],
  } as Omit<World, 'time'> as World
  // Ahead of the clock's own hooks, so it sees each period before they answer it; the clock
  // registers the bare event, so this one has a matcher.
  on('clock.every', {}, ($, e, next) => {
    w.periods += 1
    return next(e)
  })
  w.time = mock.clock(on, { now: 1_000_000 })
  on('env.get', ($, e) => {
    if (!w.isEnvReadable) return { deny: 'the environment cannot be read here' }
    if (kept !== undefined && e.name === 'TICKET_PANES_TICKET') return { deny: 'the variable cannot be read here' }
    return { value: env[e.name] }
  })
  if (kept !== undefined) on('state.get', roleRef, () => ({ value: { value: kept, version: 1 } }))
  on('fs.stat', ($, e) => {
    w.stats.push(e.path)
    if (e.path !== FILE || w.ticket === undefined) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
    return { value: { kind: 'file', size: w.ticket.text.length, mtimeMs: w.ticket.mtimeMs, isLink: false } }
  })
  on('fs.read', ($, e) => {
    if (e.path !== FILE || w.ticket === undefined) return { deny: `ENOENT: no such file or directory, open '${e.path}'` }
    return { value: w.ticket.text }
  })
  on('fs.exists', ($, e) => ({ value: e.path === FILE && w.ticket !== undefined }))
  on('state.set', bandModeRef, ($, e, next) => {
    w.modes.push(e.value)
    return next(e)
  })
  on('state.set', ticketVersionRef, ($, e, next) => {
    if (w.versionRefusals > 0) {
      w.versionRefusals -= 1
      return { deny: 'the write was refused' }
    }
    w.versions.push(e.value)
    return next(e)
  })
  // side.ts records the session on a counted prompt.
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: '/repo' }))
  mock.store(on)
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{BENEATH}</Text>
  })
  return w
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

// A prompt the person typed (R5's counted prompt).
async function say($: Engine): Promise<void> {
  await $.prompt.submit({ text: 'what next?', wait: false, origin: ORIGIN })
}

async function slash($: Engine, name: string): Promise<void> {
  await $.prompt.submit({ text: `/${name}`, command: { name, args: '' }, wait: false, origin: ORIGIN })
}

async function hidden($: Engine): Promise<void> {
  await $.prompt.submit({ text: 'a hidden prompt', isMeta: true, wait: false, origin: ORIGIN })
}

async function end($: Engine, reason: 'clear' | 'resume' | 'other'): Promise<void> {
  await $.session.end({ reason, sessionId: 'S1', resume: { id: 'S1' } })
}

function mount($: Engine, surface: (typeof SURFACES)[number] = 'terminal', hasSurvey = false) {
  return $.ui.mount({ ...BAND, surface, props: { ...BAND.props, hasSurvey } })
}

type Band = Awaited<ReturnType<typeof mount>>
type Drawn = { type: string; props?: Record<string, unknown>; children?: Drawn[] }

// The band's form: the ticket's box drawn compact or expanded (by its toggle), or collapsed (by
// its `+`), with what the hooks beneath drew under it; or only what they drew.
async function form(ui: Band): Promise<string> {
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
  if (keys.includes(VIEW_KEYS.restore)) return 'collapsed'
  if (keys.includes(VIEW_KEYS.showLess)) return 'expanded'
  if (keys.includes(VIEW_KEYS.showAll)) return 'compact'
  return 'none'
}

async function texts(ui: Band): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text)
}

function change(w: World, mtimeMs: number, text: string): void {
  w.ticket = { mtimeMs, text }
}

// ---------- what the band draws ----------

test('AC: a new side session draws the ticket compact before any prompt, above the band beneath', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await start($)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const drawn = (await ui.drawn()) as Drawn
    expect(drawn).toMatchObject({ type: 'Box', props: { flexDirection: 'column' } })
    expect(drawn.children).toHaveLength(2)
    expect(drawn.children?.[0]).toMatchObject({ type: 'Box', props: { borderStyle: 'round' } })
    expect(drawn.children?.[1]).toMatchObject({ type: 'Text', children: [BENEATH] })
    expect(await texts(ui)).toEqual(['x-ab12', 'open · task · P2', 'Widen the widget', '0 notes', BENEATH])
    expect((await ui.find({ type: 'Markdown', key: VIEW_KEYS.description }))?.text).toBe('The first text.')
    expect(await form(ui)).toBe('compact')
    await ui.unmount()
  }
  // Unset reads as compact: nothing was written.
  expect(w.modes).toEqual([])
})

test('after a reload the first draw resolves the role and draws the ticket compact', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($)
  expect(await form(ui)).toBe('compact')
  expect((await texts(ui)).at(-1)).toBe(BENEATH)
  expect(w.modes).toEqual([])
})

test('AC: a main session draws exactly what the hooks beneath draw, and starts no poll', async ($, on) => {
  const w = world(on, MAIN_ENV)
  await start($)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.drawn()).toMatchObject({ type: 'Text', children: [BENEATH] })
    await ui.unmount()
  }
  await w.time.advance(10_000)
  expect(w.periods).toBe(0)
  expect(w.stats).not.toContain(FILE)
})

test('a main session leaves the mode alone on prompts and /clear', async ($, on) => {
  const w = world(on, MAIN_ENV)
  await say($)
  await end($, 'clear')
  await say($)
  expect(w.modes).toEqual([])
  expect(w.prompts).toEqual(['what next?', 'what next?'])
})

// The kind decides, and a side role names its ticket: a kept role with one but not the other is no
// side session, so the band leaves it alone.
test('a kept role of kind main that names a ticket draws no ticket and polls nothing', async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR }, { kind: 'main', sideTicket: 'x-ab12' })
  const ui = await mount($)
  expect(await ui.drawn()).toMatchObject({ type: 'Text', children: [BENEATH] })
  await say($)
  expect(w.modes).toEqual([])
  expect(w.periods).toBe(0)
})

test('a kept role of kind side that names no ticket draws no ticket and polls nothing', async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR }, { kind: 'side' })
  const ui = await mount($)
  expect(await ui.drawn()).toMatchObject({ type: 'Text', children: [BENEATH] })
  await say($)
  expect(w.modes).toEqual([])
  expect(w.periods).toBe(0)
})

test('a kept role of kind side with its ticket draws the band', async ($, on) => {
  world(on, { TICKETS_DIR: DIR }, { kind: 'side', sideTicket: 'x-ab12' })
  expect(await form(await mount($))).toBe('compact')
})

test('a survey holds the band: only the hooks beneath draw, and the draw still starts the poll', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($, 'terminal', true)
  expect(await ui.drawn()).toMatchObject({ type: 'Text', children: [BENEATH] })
  expect(w.periods).toBe(1)
  await ui.redraw({ ...BAND.props, hasSurvey: false })
  expect(await form(ui)).toBe('compact')
})

test('the band draws again once the role is stored', async ($, on) => {
  const w = world(on, SIDE_ENV)
  w.isEnvReadable = false
  const ui = await mount($)
  // Neither the environment nor `$.state` could say: main for now.
  expect(await ui.drawn()).toMatchObject({ type: 'Text', children: [BENEATH] })
  w.isEnvReadable = true
  await start($)
  expect(await form(ui)).toBe('compact')
})

// ---------- the modes ----------

test('AC: the first counted prompt collapses the band; /model and a hidden prompt do not', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await start($)
  const ui = await mount($)
  await slash($, 'model')
  await hidden($)
  expect(await form(ui)).toBe('compact')
  expect(w.modes).toEqual([])
  await say($)
  expect(await form(ui)).toBe('collapsed')
  expect(await texts(ui)).toEqual(['x-ab12 · open · Widen the widget', BENEATH])
  expect(w.modes).toEqual(['collapsed'])
  // Every prompt still reached the engine.
  expect(w.prompts).toEqual(['/model', 'a hidden prompt', 'what next?'])
})

test('AC: pressing the collapsed row makes it compact, and the next counted prompt leaves it so; Show all expands, and stays', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($)
  await say($)
  expect(await form(ui)).toBe('collapsed')
  await ui.press({ key: VIEW_KEYS.restore })
  expect(await form(ui)).toBe('compact')
  await say($)
  expect(await form(ui)).toBe('compact')
  await ui.press({ key: VIEW_KEYS.showAll })
  expect(await form(ui)).toBe('expanded')
  await say($)
  expect(await form(ui)).toBe('expanded')
  await ui.press({ key: VIEW_KEYS.showLess })
  expect(await form(ui)).toBe('compact')
  expect(w.modes).toEqual(['collapsed', 'compact', 'expanded', 'compact'])
})

test('Show all before the first counted prompt: that prompt still collapses the band (D7)', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($)
  await ui.press({ key: VIEW_KEYS.showAll })
  expect(await form(ui)).toBe('expanded')
  await say($)
  expect(await form(ui)).toBe('collapsed')
  expect(w.modes).toEqual(['expanded', 'collapsed'])
})

test('AC: after /clear the band is compact, and the next counted prompt collapses it', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($)
  await say($)
  await end($, 'clear')
  expect(await form(ui)).toBe('compact')
  await say($)
  expect(await form(ui)).toBe('collapsed')
  expect(w.modes).toEqual(['collapsed', 'compact', 'collapsed'])
})

test('/clear on a band the person expanded makes it compact too', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($)
  await say($)
  await ui.press({ key: VIEW_KEYS.restore })
  await ui.press({ key: VIEW_KEYS.showAll })
  await end($, 'clear')
  expect(await form(ui)).toBe('compact')
  expect(w.modes.at(-1)).toBe('compact')
})

test('a session that ends for another reason leaves the mode, and the next counted prompt too', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($)
  await say($)
  await ui.press({ key: VIEW_KEYS.restore })
  for (const reason of ['resume', 'other'] as const) {
    await end($, reason)
    await say($)
  }
  expect(await form(ui)).toBe('compact')
  expect(w.modes).toEqual(['collapsed', 'compact'])
})

// ---------- the poll ----------

test('AC: after a reload, a change of the ticket file shows within 5 s; an unchanged mtime redraws nothing', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($)
  expect(w.periods).toBe(1)
  // A look at the file as it was drawn bumps nothing.
  await w.time.advance(2500)
  expect(w.versions).toEqual([])
  change(w, 200, V2)
  // Not drawn again until the poll sees it.
  expect(await texts(ui)).toContain('Widen the widget')
  await w.time.advance(2500)
  expect(await texts(ui)).toContain('Narrow the widget')
  expect(await texts(ui)).toContain('in_progress · task · P2')
  expect(w.versions).toEqual([1])
  // New text under the same mtime is no change the poll sees, so nothing draws again.
  change(w, 200, V1)
  await w.time.advance(5000)
  expect(await texts(ui)).toContain('Narrow the widget')
  expect(w.versions).toEqual([1])
})

test('AC: in a new session too, a change shows within 5 s, and the poll runs once per load', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await start($)
  const ui = await mount($)
  await ui.redraw()
  await start($)
  expect(w.periods).toBe(1)
  change(w, 300, V2)
  await w.time.advance(2500)
  expect(await texts(ui)).toContain('Narrow the widget')
})

test('a collapsed band redraws from the file too', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($)
  await say($)
  change(w, 200, V2)
  await w.time.advance(2500)
  expect(await texts(ui)).toEqual(['x-ab12 · in_progress · Narrow the widget', BENEATH])
})

test('a file that goes and comes back with its old mtime redraws each time', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($)
  w.ticket = undefined
  await w.time.advance(2500)
  expect(await texts(ui)).toEqual(['ticket x-ab12: file not found', BENEATH])
  change(w, 100, V2)
  await w.time.advance(2500)
  expect(await texts(ui)).toContain('Narrow the widget')
  expect(w.versions).toEqual([1, 2])
})

test('a version write the engine refuses is tried again on the next look', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const ui = await mount($)
  w.versionRefusals = 1
  change(w, 200, V2)
  await w.time.advance(2500)
  expect(w.versions).toEqual([])
  expect(w.logs.some(l => l.includes('could not note a change of ticket x-ab12') && l.includes('the write was refused'))).toBe(true)
  await w.time.advance(2500)
  expect(w.versions).toEqual([1])
  expect(await texts(ui)).toContain('Narrow the widget')
})

test('with no tickets folder, the band says the file is not found and the poll looks at no ticket file', async ($, on) => {
  const w = world(on, { TICKET_PANES_TICKET: 'x-ab12' })
  const ui = await mount($)
  expect(await texts(ui)).toEqual(['ticket x-ab12: file not found', BENEATH])
  await w.time.advance(5000)
  // The poll ran: its first period and the two after it.
  expect(w.periods).toBe(3)
  expect(w.stats.filter(path => path.endsWith('/x-ab12.md'))).toEqual([])
})
