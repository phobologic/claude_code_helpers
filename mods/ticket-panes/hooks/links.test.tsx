import type { On, PaneOpenArgs } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ticketsIn } from './links'

// links.tsx: `ticketsIn` on its own, then the row through the engine. The plugin loads fresh for
// each test, so R1's caches start over. The test's hooks stand in for the world beneath it: the
// environment (no herdr, so a press takes the read-only pane), the clock (R1 reads it on a miss),
// the ticket files, the surface's panes, toasts and debug log, and the engine's own row for a reply
// block, which the hook draws first.

const DIR = '/repo/.tickets'
// What the hooks beneath draw for a reply block: the engine's own row.
const ENGINE_ROW = { type: 'engine', ref: 0 }
const OTHER_SURFACES = ['desktop', 'vscode', 'mobile'] as const
// Eleven ticket ids, x-a001 to x-a011.
const ELEVEN = Array.from({ length: 11 }, (_, i) => `x-a${String(i + 1).padStart(3, '0')}`)
const PANE_OPEN = (id: string) => ({ id: 'ticket-panes', title: id, focus: true, closeOnEscape: true })

type World = { opens: PaneOpenArgs[]; toasts: string[]; logs: string[] }

// The world beneath the plugin, where the ticket files are those of `tickets`.
function world(on: On, tickets: string[]): World {
  const w: World = { opens: [], toasts: [], logs: [] }
  const files = new Set(tickets.map(id => `${DIR}/${id}.md`))
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { TICKETS_DIR: DIR })
  on('session.root', () => ({ value: '/repo' }))
  on('fs.stat', ($, e) => {
    if (!files.has(e.path)) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
    return { value: { kind: 'file', size: 10, mtimeMs: 100, isLink: false } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    w.opens.push({ ...e })
    return { value: { isPlaced: true } }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AssistantMessage' }, () => ENGINE_ROW)
  return w
}

type Surface = 'terminal' | (typeof OTHER_SURFACES)[number]

// A reply block of `text`, drawn on `surface`; a summary of the model's text when `isSummary`.
function mount($: Engine, text: string, surface: Surface = 'terminal', isSummary = false) {
  const props = isSummary ? { text, isFirstOfReply: true, isSummary: true as const } : { text, isFirstOfReply: true }
  return $.ui.mount({ plugin: 'ticket-panes', surface, component: 'AssistantMessage', props })
}

type Reply = Awaited<ReturnType<typeof mount>>
type Drawn = { type: string; props?: Record<string, unknown>; children?: (Drawn | string)[] }

// The ticket row's parts in order: a Text as `text <its text>`, dim or not; a Button as
// `button <key> <label>`.
async function rowParts(ui: Reply): Promise<string[]> {
  const drawn = (await ui.drawn()) as Drawn
  const row = drawn.children?.[1] as Drawn
  return (row.children ?? []).map(part => {
    const el = part as Drawn
    if (el.type === 'Button') return `button ${String(el.props?.key)} ${String(el.props?.label)}`
    return `text ${(el.children ?? []).join('')}${el.props?.dimColor === true ? ' (dim)' : ''}`
  })
}

function buttons(ids: string[]): string[] {
  return ids.map(id => `button ticket-${id} ${id}`)
}

// ---------- ticketsIn ----------

test('AC: ticketsIn lists each candidate once, in order of first mention', () => {
  expect(ticketsIn('Start with x-cd34, then x-ab12, then x-cd34 again.')).toEqual(['x-cd34', 'x-ab12'])
  expect(ticketsIn('x-ef56\nthen x-cd34\nand x-ef56 and x-ab12')).toEqual(['x-ef56', 'x-cd34', 'x-ab12'])
  expect(ticketsIn('nothing here')).toEqual([])
})

test('AC: x-ab12s, docs/x-ab12.md and an id inside a fenced block are none; one in inline code is', () => {
  expect(ticketsIn('see x-ab12s')).toEqual([])
  expect(ticketsIn('see docs/x-ab12.md')).toEqual([])
  expect(ticketsIn('run\n```\ntk show x-ab12\n```\ndone')).toEqual([])
  expect(ticketsIn('run `tk show x-ab12` now')).toEqual(['x-ab12'])
})

test('a candidate is not preceded by a word character, a slash, a dot or a dash', () => {
  // Neither `ab-cd34` (after a dash) nor `b-cd34` (after a letter) is one.
  expect(ticketsIn('x-ab-cd34')).toEqual([])
  expect(ticketsIn('_x-ab12')).toEqual([])
  expect(ticketsIn('see .x-ab12')).toEqual([])
  expect(ticketsIn('see a/x-ab12')).toEqual([])
  // A token whose prefix holds a dot is one, whole.
  expect(ticketsIn('see app.x-ab12')).toEqual(['app.x-ab12'])
  // At the start of the text, and after a space, a bracket, a quote or a backtick.
  expect(ticketsIn('x-ab12 (x-cd34) "x-ef56" `x-ab34` [x-cd56]')).toEqual(['x-ab12', 'x-cd34', 'x-ef56', 'x-ab34', 'x-cd56'])
})

test('a candidate is not followed by a word character or a dash; a dot, comma or bracket may follow', () => {
  expect(ticketsIn('x-ab12_')).toEqual([])
  expect(ticketsIn('x-ab12-z')).toEqual([])
  expect(ticketsIn('x-ab123')).toEqual([])
  expect(ticketsIn('x-ab12. x-cd34, (x-ef56)')).toEqual(['x-ab12', 'x-cd34', 'x-ef56'])
})

test('a candidate is a prefix of letters, digits, dots and underscores, a dash, then four lowercase letters or digits', () => {
  expect(ticketsIn('my_app.v2-ab12 and 42-0a9z')).toEqual(['my_app.v2-ab12', '42-0a9z'])
  // Uppercase or too short a suffix, or a prefix that starts with an underscore, is none.
  expect(ticketsIn('x-AB12 x-ab1 _-ab12')).toEqual([])
})

// ---------- fenced blocks ----------

test('ids after a closed fence count again, in backtick and tilde fences alike', () => {
  expect(ticketsIn('```sh\ntk show x-ab12\n```\nthen x-cd34')).toEqual(['x-cd34'])
  expect(ticketsIn('~~~\ntk show x-ab12\n~~~\nthen x-cd34')).toEqual(['x-cd34'])
})

test('the fence line itself holds no candidate: its info string is the fence', () => {
  expect(ticketsIn('```x-ab12\nls\n```')).toEqual([])
  expect(ticketsIn('~~~ x-ab12\nls\n~~~')).toEqual([])
})

test('only a bare run of the same character, at least as long, closes a fence', () => {
  // A shorter run closes nothing.
  expect(ticketsIn('````\n```\nx-ab12\n```\nx-cd34\n````\nx-ef56')).toEqual(['x-ef56'])
  // The other character closes nothing.
  expect(ticketsIn('```\n~~~\nx-ab12\n~~~\nx-cd34\n```\nx-ef56')).toEqual(['x-ef56'])
  // A run with an info string after it opens nothing inside a block, and closes nothing.
  expect(ticketsIn('```\n```sh\nx-ab12\n```\nx-cd34')).toEqual(['x-cd34'])
  expect(ticketsIn('```\n``` x\nx-ab12\n```\nx-cd34')).toEqual(['x-cd34'])
  // A longer run closes it, with spaces around.
  expect(ticketsIn('```\nx-ab12\n  `````  \nx-cd34')).toEqual(['x-cd34'])
})

test('two backticks or two tildes open no fence', () => {
  expect(ticketsIn('``\nx-ab12\n``\n~~\nx-cd34\n~~')).toEqual(['x-ab12', 'x-cd34'])
})

test('a fence never closed runs to the end of the text', () => {
  expect(ticketsIn('x-ab12\n```\nx-cd34\nx-ef56')).toEqual(['x-ab12'])
})

test('an indented fence, as in a list item, is a fence', () => {
  expect(ticketsIn('1. Run:\n   ```\n   tk show x-ab12\n   ```\n2. Then x-cd34')).toEqual(['x-cd34'])
})

test('a line led by inline code in triple backticks opens no fence', () => {
  expect(ticketsIn('```x-ab12``` is the one\nand x-cd34')).toEqual(['x-ab12', 'x-cd34'])
  // A tilde fence's info string may hold backticks: it still opens one.
  expect(ticketsIn('~~~ `sh`\nx-ab12\n~~~\nx-cd34')).toEqual(['x-cd34'])
})

// ---------- the row ----------

test('AC: a terminal reply mentioning x-cd34, x-ab12, x-cd34 draws the engine row, then tickets: x-cd34 x-ab12', async ($, on) => {
  world(on, ['x-ab12', 'x-cd34'])
  const ui = await mount($, 'Start with x-cd34, then x-ab12, then x-cd34 again.')
  const drawn = (await ui.drawn()) as Drawn
  expect(drawn).toMatchObject({ type: 'Box', props: { flexDirection: 'column' } })
  expect(drawn.children).toHaveLength(2)
  expect(drawn.children?.[0]).toEqual(ENGINE_ROW)
  // One row under the reply's text, past its bullet, wrapping when wider than the screen.
  expect(drawn.children?.[1]).toMatchObject({ type: 'Box', props: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, paddingLeft: 2 } })
  expect(await rowParts(ui)).toEqual(['text tickets: (dim)', ...buttons(['x-cd34', 'x-ab12'])])
})

test('AC: pressing x-ab12 opens x-ab12 as $.ticketPanes.open({ id: "x-ab12" }) does; x-cd34 opens x-cd34', async ($, on) => {
  const w = world(on, ['x-ab12', 'x-cd34'])
  const ui = await mount($, 'Start with x-cd34, then x-ab12, then x-cd34 again.')
  await ui.press({ key: 'ticket-x-ab12' })
  // Outside herdr the noun opens the read-only pane on the ticket, with nothing to say.
  expect(w.opens).toEqual([PANE_OPEN('x-ab12')])
  expect(w.toasts).toEqual([])
  await ui.press({ key: 'ticket-x-cd34' })
  expect(w.opens).toEqual([PANE_OPEN('x-ab12'), PANE_OPEN('x-cd34')])
  expect(w.toasts).toEqual([])
  // Neither press failed into the debug log.
  expect(w.logs.filter(line => line.includes('button'))).toEqual([])
})

test('AC: a reply mentioning 11 tickets draws 8 buttons, the first 8 mentioned, and +3 more', async ($, on) => {
  world(on, ELEVEN)
  const ui = await mount($, `Tickets: ${ELEVEN.join(', ')}.`)
  expect(await rowParts(ui)).toEqual(['text tickets: (dim)', ...buttons(ELEVEN.slice(0, 8)), 'text +3 more (dim)'])
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(8)
})

test('8 tickets draw 8 buttons and no +N more; 9 draw 8 and +1 more', async ($, on) => {
  world(on, ELEVEN)
  const eight = await mount($, ELEVEN.slice(0, 8).join(' '))
  expect(await rowParts(eight)).toEqual(['text tickets: (dim)', ...buttons(ELEVEN.slice(0, 8))])
  const nine = await mount($, ELEVEN.slice(0, 9).join(' '))
  expect(await rowParts(nine)).toEqual(['text tickets: (dim)', ...buttons(ELEVEN.slice(0, 8)), 'text +1 more (dim)'])
})

test('a candidate that is no ticket gets no button and is not counted in +N more', async ($, on) => {
  world(on, [...ELEVEN.slice(0, 9), 'x-ab12'])
  const ui = await mount($, `x-zz01 ${ELEVEN.slice(0, 9).join(' ')} read-only x-zz02`)
  expect(await rowParts(ui)).toEqual(['text tickets: (dim)', ...buttons(ELEVEN.slice(0, 8)), 'text +1 more (dim)'])
  const few = await mount($, 'a read-only look at x-ab12, not x-zz01')
  expect(await rowParts(few)).toEqual(['text tickets: (dim)', ...buttons(['x-ab12'])])
})

test('AC: x-ab12s, docs/x-ab12.md and an id in a fenced block get no button; one in inline code does', async ($, on) => {
  world(on, ['x-ab12', 'x-cd34', 'x-ef56'])
  const ui = await mount($, 'Not x-ab12s or docs/x-ab12.md:\n```\ntk show x-cd34\n```\nbut `x-ef56`.')
  expect(await rowParts(ui)).toEqual(['text tickets: (dim)', ...buttons(['x-ef56'])])
})

// ---------- next(e) itself ----------

test('AC: a reply whose candidates are no tickets, or that has none, draws next(e) itself', async ($, on) => {
  world(on, ['x-ab12'])
  expect(await (await mount($, 'a read-only look at x-zz01 and x-ab12s')).drawn()).toEqual(ENGINE_ROW)
  expect(await (await mount($, 'nothing to see')).drawn()).toEqual(ENGINE_ROW)
  expect(await (await mount($, '```\nx-ab12\n```')).drawn()).toEqual(ENGINE_ROW)
})

test('AC: a summary of the model\'s text draws next(e) itself, tickets or not', async ($, on) => {
  world(on, ['x-ab12', 'x-cd34'])
  const ui = await mount($, 'Looked at x-ab12 and x-cd34', 'terminal', true)
  expect(await ui.drawn()).toEqual(ENGINE_ROW)
})

test('AC: any surface but the terminal draws next(e) itself, tickets or not', async ($, on) => {
  world(on, ['x-ab12', 'x-cd34'])
  for (const surface of OTHER_SURFACES) {
    const ui = await mount($, 'Start with x-cd34, then x-ab12.', surface)
    expect(await ui.drawn()).toEqual(ENGINE_ROW)
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  }
})
