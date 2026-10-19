import type { EngineInterface, FsStat, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { TicketPanesBandMode } from '../types'
import { TicketView, VIEW_KEYS, parseTicket, readTicket } from './view'
import type { Ticket, TicketRead } from './view'

// ---------- tickets as tk writes them ----------

// A task as /spec files one: criteria under a heading, then two notes.
const TASK = [
  '---',
  'id: x-ab12',
  'status: open',
  'deps: []',
  'links: []',
  'created: 2030-03-01T10:00:00Z',
  'type: task',
  'priority: 2',
  'assignee: someone',
  'parent: x-cd34',
  'tags: [phase-1]',
  '---',
  '# Draw the widget',
  '',
  'The widget shows a summary of the thing.',
  '',
  'It opens from the menu.',
  '',
  '## Acceptance Criteria',
  '',
  '- When the widget opens, it shall show the summary.',
  '- When it closes, it shall show nothing.',
  '',
  '## Notes',
  '',
  '**2030-03-01T11:00:00Z**',
  '',
  'Started on the widget.',
  '',
  '**2030-03-01T12:00:00Z**',
  '',
  'The widget draws.',
  '',
].join('\n')

const TASK_DESCRIPTION = 'The widget shows a summary of the thing.\n\nIt opens from the menu.'
const TASK_CRITERIA = '## Acceptance Criteria\n\n- When the widget opens, it shall show the summary.\n- When it closes, it shall show nothing.'
const TASK_NOTES = ['**2030-03-01T11:00:00Z**\n\nStarted on the widget.', '**2030-03-01T12:00:00Z**\n\nThe widget draws.']

// A review finding: bold-line criteria between other bold lines, and notes that restate the
// criteria or carry a heading of their own.
const FINDING = [
  '---',
  'id: x-ef56',
  'status: in_progress',
  'type: bug',
  'priority: 1',
  'parent: x-cd34',
  '---',
  '# Expire the cache',
  '',
  '**Files**: src/cache.ts:12',
  '**Description**: entries never expire.',
  '**Acceptance criteria**',
  '- WHEN entry #2 is older than a **minute** THEN it is read again',
  '**--max-age** keeps its meaning',
  '**Confidence**: 80',
  '',
  '## Notes',
  '',
  '**2030-03-02T09:00:00Z**',
  '',
  'ACCEPTANCE CRITERIA: restated for the fix',
  '- WHEN the clock moves THEN entries expire',
  '',
  '**2030-03-02T10:00:00Z**',
  '',
  'Found the cause.',
  '',
  '## Cause',
  'the timer was never set',
  '',
].join('\n')

const FINDING_CRITERIA = '**Acceptance criteria**\n- WHEN entry #2 is older than a **minute** THEN it is read again\n**--max-age** keeps its meaning'
const FINDING_DESCRIPTION = '**Files**: src/cache.ts:12\n**Description**: entries never expire.\n**Confidence**: 80'
const FINDING_NOTES = [
  '**2030-03-02T09:00:00Z**\n\nACCEPTANCE CRITERIA: restated for the fix\n- WHEN the clock moves THEN entries expire',
  '**2030-03-02T10:00:00Z**\n\nFound the cause.\n\n## Cause\nthe timer was never set',
]

// ---------- parseTicket ----------

test('a task: the four fields, the title, the description without the criteria, and each note', () => {
  expect(parseTicket('x-ab12', TASK)).toStrictEqual({
    id: 'x-ab12',
    status: 'open',
    type: 'task',
    priority: '2',
    parent: 'x-cd34',
    title: 'Draw the widget',
    description: TASK_DESCRIPTION,
    criteria: TASK_CRITERIA,
    notes: TASK_NOTES,
  })
})

test('E18: bold-line criteria end at the next bold line, not at a bold flag; notes keep their criteria and headings', () => {
  const finding = parseTicket('x-ef56', FINDING)
  expect(finding.criteria).toBe(FINDING_CRITERIA)
  expect(finding.description).toBe(FINDING_DESCRIPTION)
  expect(finding.notes).toEqual(FINDING_NOTES)
})

test('E18: a criteria heading of any level or case, or a criteria: line, starts the criteria; a # heading ends them', () => {
  const heading = parseTicket('x-ab12', ['# T', '', 'Intro.', '', '### acceptance criteria', '- one', '', '  ## Design', 'Plain.'].join('\n'))
  expect(heading.criteria).toBe('### acceptance criteria\n- one')
  expect(heading.description).toBe('Intro.\n\n  ## Design\nPlain.')
  // Only at the start of a line, after any indent.
  const line = parseTicket('x-ab12', ['# T', '', 'Intro: see the acceptance criteria: below.', '  Acceptance Criteria: it reads all three forms.', 'and keeps going.'].join('\n'))
  expect(line.criteria).toBe('Acceptance Criteria: it reads all three forms.\nand keeps going.')
  expect(line.description).toBe('Intro: see the acceptance criteria: below.')
})

test('E18: criteria are looked for only above ## Notes', () => {
  const text = ['# T', '', 'No criteria here.', '', '## Notes', '', '**2030-03-01T11:00:00Z**', '', '## Acceptance Criteria', '- in a note'].join('\n')
  const ticket = parseTicket('x-ab12', text)
  expect(ticket.criteria).toBe('')
  expect(ticket.description).toBe('No criteria here.')
  expect(ticket.notes).toEqual(['**2030-03-01T11:00:00Z**\n\n## Acceptance Criteria\n- in a note'])
})

test('a ticket with no notes keeps its last line and has none', () => {
  const ticket = parseTicket('x-ab12', TASK.slice(0, TASK.indexOf('## Notes')).trimEnd())
  expect(ticket.criteria).toBe(TASK_CRITERIA)
  expect(ticket.notes).toEqual([])
})

test('a ## Notes heading with more words after it, or a ### Notes one, is part of the description', () => {
  const ticket = parseTicket('x-ab12', ['# T', '', '## Notes for the reviewer', 'Look at the cache.', '### Notes', 'And the timer.'].join('\n'))
  expect(ticket.description).toBe('## Notes for the reviewer\nLook at the cache.\n### Notes\nAnd the timer.')
  expect(ticket.notes).toEqual([])
})

test('text above the first note is a block of its own', () => {
  const ticket = parseTicket('x-ab12', ['# T', '', '## Notes', '', 'See the design doc.', '', '**2030-03-01T11:00:00Z**', '', 'A note.'].join('\n'))
  expect(ticket.notes).toEqual(['See the design doc.', '**2030-03-01T11:00:00Z**\n\nA note.'])
})

test('without frontmatter or a title, the fields and title are empty and the text is the description', () => {
  expect(parseTicket('x-ab12', ['Just text.', '', '## Notes', '', '**2030-03-01T11:00:00Z**', '', '# Not a title'].join('\n'))).toStrictEqual({
    id: 'x-ab12',
    status: '',
    type: '',
    priority: '',
    parent: '',
    title: '',
    description: 'Just text.',
    criteria: '',
    notes: ['**2030-03-01T11:00:00Z**\n\n# Not a title'],
  })
})

test('frontmatter is only a first line --- up to the next ---; the title is the first # heading', () => {
  // Not closed: no frontmatter, so no fields.
  const unclosed = parseTicket('x-ab12', ['---', 'status: open', '# Title', 'Text.'].join('\n'))
  expect([unclosed.status, unclosed.title, unclosed.description]).toEqual(['', 'Title', 'Text.'])
  // A --- pair further down is a rule in the description, not frontmatter.
  const ruled = parseTicket('x-ab12', ['# Title', '---', 'status: closed', '---', 'Text.'].join('\n'))
  expect([ruled.status, ruled.title, ruled.description]).toEqual(['', 'Title', '---\nstatus: closed\n---\nText.'])
  // A ## heading above the title is not it.
  const sub = parseTicket('x-ab12', ['---', 'type: task', '---', '## Context', '# Title', 'Text.'].join('\n'))
  expect([sub.type, sub.title]).toEqual(['task', 'Title'])
})

test('field values are trimmed, and only status, type, priority and parent are read', () => {
  const ticket = parseTicket('x-ab12', ['---', 'status:   closed  ', 'typed: no', 'subtype: no', 'priority:0', '---', '# T'].join('\n'))
  expect([ticket.status, ticket.type, ticket.priority, ticket.parent]).toEqual(['closed', '', '0', ''])
})

test('a line with a bold time and more text is part of its note', () => {
  const text = ['# T', '', '## Notes', '', '**2030-03-01T11:00:00Z**', '', 'It broke at', '**2030-03-01T09:00:00Z** and again later,', 'first seen at **2030-03-01T08:00:00Z**'].join('\n')
  expect(parseTicket('x-ab12', text).notes).toEqual([
    '**2030-03-01T11:00:00Z**\n\nIt broke at\n**2030-03-01T09:00:00Z** and again later,\nfirst seen at **2030-03-01T08:00:00Z**',
  ])
})

test('a file with CRLF or CR line endings reads as the same ticket', () => {
  expect(parseTicket('x-ab12', TASK.replace(/\n/g, '\r\n'))).toStrictEqual(parseTicket('x-ab12', TASK))
  expect(parseTicket('x-ab12', TASK.replace(/\n/g, '\r'))).toStrictEqual(parseTicket('x-ab12', TASK))
})

test('fields come only from the frontmatter, and its closing --- is not body text', () => {
  const ticket = parseTicket('x-ab12', ['---', 'status: open', '---', 'Body text.', 'status: closed', 'parent: x-zz99'].join('\n'))
  expect([ticket.status, ticket.parent, ticket.title, ticket.description]).toEqual(['open', '', '', 'Body text.\nstatus: closed\nparent: x-zz99'])
})

test('a stamp without its Z still starts a note', () => {
  const text = ['# T', '', '## Notes', '', '**2030-03-01T11:00:00Z**', '', 'One.', '', '**2030-03-01T12:00:00**', '', 'Two.'].join('\n')
  expect(parseTicket('x-ab12', text).notes).toEqual(['**2030-03-01T11:00:00Z**\n\nOne.', '**2030-03-01T12:00:00**\n\nTwo.'])
})

test('a # line inside a fenced block does not end the criteria', () => {
  for (const fence of ['```', '~~~']) {
    const criteria = ['## Acceptance Criteria', '- Running the setup prints ok:', `  ${fence}bash`, '  # from the repo root', '  ./setup.sh', `  ${fence}`, '- A second run changes nothing.']
    const ticket = parseTicket('x-ab12', ['# T', '', 'Intro.', '', ...criteria, '', '## Design', 'Plain.'].join('\n'))
    expect(ticket.criteria).toBe(criteria.join('\n'))
    // After the fence closes, a heading ends them again.
    expect(ticket.description).toBe('Intro.\n\n## Design\nPlain.')
  }
  // Only a line that starts with a fence opens one, after any indent.
  const inline = parseTicket('x-ab12', ['# T', '## Acceptance Criteria', '- Quote it as ```a``` here.', '## Design'].join('\n'))
  expect([inline.criteria, inline.description]).toEqual(['## Acceptance Criteria\n- Quote it as ```a``` here.', '## Design'])
})

test('a line led by two backticks or two tildes opens no fence', () => {
  // Each line in a parse of its own: together they would close each other's fence.
  for (const line of ['~~Two, dropped.~~', '``tk show`` prints it.']) {
    const criteria = ['## Acceptance Criteria', '- One.', line]
    const ticket = parseTicket('x-ab12', ['# T', ...criteria, '## Design', 'Plain.'].join('\n'))
    expect([ticket.criteria, ticket.description]).toEqual([criteria.join('\n'), '## Design\nPlain.'])
  }
})

test('a fence closes only on a bare fence of its own kind, at least as long', () => {
  const blocks = [
    ['```md', '~~~', '```'],
    ['```md', '```sh', '```'],
    ['````md', '```', '````'],
  ]
  for (const [open, inner, close] of blocks) {
    const criteria = ['## Acceptance Criteria', '- It shows:', `  ${open}`, `  ${inner}`, '  # not a heading', `  ${close}`, '- Done.']
    const ticket = parseTicket('x-ab12', ['# T', ...criteria, '## Design', 'Plain.'].join('\n'))
    expect([ticket.criteria, ticket.description]).toEqual([criteria.join('\n'), '## Design\nPlain.'])
  }
  // A fence opened above the criteria is still open where they start: its close stays in them,
  // and the next heading after it ends them. (The criteria start inside the fence today; backlog
  // ticket cc-7ted is to stop that.)
  const ticket = parseTicket('x-ab12', ['# T', '```md', '## Acceptance Criteria', '- a', '```', '## Design', 'Plain.'].join('\n'))
  expect([ticket.criteria, ticket.description]).toEqual(['## Acceptance Criteria\n- a\n```', '```md\n## Design\nPlain.'])
})

// ---------- readTicket ----------
// readTicket is called by no hook of this task, and a test's own hooks cannot call `$`, so it
// runs against this stand-in. R1's caches (tickets.ts) carry over from test to test in this
// file, so each test has a tickets dir of its own.

type World = {
  env?: Record<string, string>
  isEnvRefused?: boolean
  // File path to its text.
  files?: Record<string, string>
  // File path to what a read of it rejects with.
  readFailures?: Record<string, unknown>
}

function fake(world: World) {
  const seen = { reads: [] as string[], exists: [] as string[] }
  const $ = {
    env: {
      get: async (name: string) => {
        if (world.isEnvRefused) throw new Error('env.get: refused')
        return world.env?.[name]
      },
    },
    session: { root: async () => '/no-tickets-here' },
    clock: { now: async () => 0 },
    fs: {
      stat: async (path: string): Promise<FsStat> => {
        if (world.files?.[path] === undefined) throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
        return { kind: 'file', size: 0, mtimeMs: 0, isLink: false }
      },
      read: async (path: string) => {
        seen.reads.push(path)
        const failure = world.readFailures?.[path]
        if (failure !== undefined) throw failure
        const text = world.files?.[path]
        if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
        return text
      },
      exists: async (path: string) => {
        seen.exists.push(path)
        return world.files?.[path] !== undefined
      },
    },
  }
  return { $: $ as unknown as EngineInterface, seen }
}

test('R1: readTicket reads <tickets dir>/<id>.md', async () => {
  const r = fake({ env: { TICKETS_DIR: '/view-1/.tickets' }, files: { '/view-1/.tickets/x-ab12.md': TASK } })
  expect(await readTicket(r.$, 'x-ab12')).toStrictEqual(parseTicket('x-ab12', TASK))
  expect(r.seen.reads).toEqual(['/view-1/.tickets/x-ab12.md'])
})

test('AC: a missing file, or no tickets dir, is file not found, with nothing read', async () => {
  const missing = fake({ env: { TICKETS_DIR: '/view-2/.tickets' } })
  expect(await readTicket(missing.$, 'x-ab12')).toStrictEqual({ id: 'x-ab12', problem: 'file not found' })
  expect(missing.seen.reads).toEqual([])
  const nowhere = fake({})
  expect(await readTicket(nowhere.$, 'x-ab12')).toStrictEqual({ id: 'x-ab12', problem: 'file not found' })
})

test('an id no tk id could be is file not found, even when the file it names exists', async () => {
  const r = fake({ env: { TICKETS_DIR: '/view-3/.tickets' }, files: { '/view-3/.tickets/../x-ab12.md': TASK } })
  expect(await readTicket(r.$, '../x-ab12')).toStrictEqual({ id: '../x-ab12', problem: 'file not found' })
  expect(r.seen.reads).toEqual([])
})

test('a ticket file gone since R1 found it is file not found', async () => {
  const files: Record<string, string> = { '/view-4/.tickets/x-ab12.md': TASK }
  const r = fake({ env: { TICKETS_DIR: '/view-4/.tickets' }, files })
  expect('problem' in (await readTicket(r.$, 'x-ab12'))).toBe(false)
  delete files['/view-4/.tickets/x-ab12.md']
  expect(await readTicket(r.$, 'x-ab12')).toStrictEqual({ id: 'x-ab12', problem: 'file not found' })
  expect(r.seen.exists).toEqual(['/view-4/.tickets/x-ab12.md'])
})

test('a file there but unreadable is the read failure, on one line', async () => {
  const path = '/view-5/.tickets/x-ab12.md'
  const failure = new Error(`EACCES: permission denied,\n  open '${path}'\n`)
  const r = fake({ env: { TICKETS_DIR: '/view-5/.tickets' }, files: { [path]: TASK }, readFailures: { [path]: failure } })
  expect(await readTicket(r.$, 'x-ab12')).toStrictEqual({ id: 'x-ab12', problem: `EACCES: permission denied, open '${path}'` })
  // A rejection that is not an Error is shown as it is.
  const odd = fake({ env: { TICKETS_DIR: '/view-6/.tickets' }, files: { '/view-6/.tickets/x-ab12.md': TASK }, readFailures: { '/view-6/.tickets/x-ab12.md': 'EIO' } })
  expect(await readTicket(odd.$, 'x-ab12')).toStrictEqual({ id: 'x-ab12', problem: 'EIO' })
})

test('readTicket never rejects: a $ call that fails is the problem', async () => {
  expect(await readTicket(fake({ isEnvRefused: true }).$, 'x-ab12')).toStrictEqual({ id: 'x-ab12', problem: 'env.get: refused' })
})

// ---------- TicketView, drawn ----------

const PANE = { title: 'x-ab12', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const SURFACES = ['terminal', 'desktop'] as const

// What the test's pane draws; a test may change it and redraw. Unless `hasNoHandlers`, the
// view's presses are recorded.
type Shown = { ticket: TicketRead; mode: TicketPanesBandMode; showToggles?: boolean; hasNoHandlers?: boolean }

// Draws `shown` in a pane of the test's own (no hook of the plugin draws a view yet), so each
// surface's table checks the tree and its buttons can be pressed. What the test's hooks draw is
// the `test` plugin's, so the drawing is mounted as that plugin's.
function drawView(on: On, shown: Shown): string[] {
  const pressed: string[] = []
  on('ui.render', { component: 'Pane', requestId: 'view' }, ($, e) => {
    const handlers = shown.hasNoHandlers
      ? {}
      : { onCompact: () => { pressed.push('compact') }, onExpand: () => { pressed.push('expand') } }
    return <TicketView elements={$.ui.resolve(e)} ticket={shown.ticket} mode={shown.mode} showToggles={shown.showToggles} {...handlers} />
  })
  return pressed
}

function mountView($: Engine, surface: (typeof SURFACES)[number]) {
  return $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'view', props: PANE })
}

type View = Awaited<ReturnType<typeof mountView>>
type Drawn = { type: string; props?: Record<string, unknown>; children: Drawn[] }

async function texts(ui: View) {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text)
}

async function markdowns(ui: View) {
  return (await ui.findAll({ type: 'Markdown' })).map(m => [m.key, m.text])
}

async function buttons(ui: View) {
  return (await ui.findAll({ type: 'Button' })).map(b => [b.key, b.props.label])
}

test('AC: compact draws the id row, the fields, the description and criteria and a 2 notes line, and no note text', async ($, on) => {
  drawView(on, { ticket: parseTicket('x-ab12', TASK), mode: 'compact', showToggles: true })
  for (const surface of SURFACES) {
    const ui = await mountView($, surface)
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { flexDirection: 'column', borderStyle: 'round' } })
    // The id is the box's first row, bold.
    const first = await ui.find({ type: 'Text' })
    expect([first?.text, first?.props.bold]).toEqual(['x-ab12', true])
    expect(await texts(ui)).toEqual(['x-ab12', 'open · task · P2', 'Draw the widget', 'parent x-cd34', '2 notes'])
    expect(await markdowns(ui)).toEqual([[VIEW_KEYS.description, TASK_DESCRIPTION], [VIEW_KEYS.criteria, TASK_CRITERIA]])
    expect(await ui.findAll({ text: /Started on the widget|The widget draws/ })).toEqual([])
    expect(await buttons(ui)).toEqual([[VIEW_KEYS.showAll, 'Show all']])
    await ui.unmount()
  }
})

test('AC: bold-line criteria draw as criteria; notes that restate criteria or hold a ## line draw as notes', async ($, on) => {
  const shown: Shown = { ticket: parseTicket('x-ef56', FINDING), mode: 'compact' }
  drawView(on, shown)
  for (const surface of SURFACES) {
    shown.mode = 'compact'
    const ui = await mountView($, surface)
    expect(await markdowns(ui)).toEqual([[VIEW_KEYS.description, FINDING_DESCRIPTION], [VIEW_KEYS.criteria, FINDING_CRITERIA]])
    shown.mode = 'expanded'
    await ui.redraw()
    expect(await markdowns(ui)).toEqual([
      [VIEW_KEYS.description, FINDING_DESCRIPTION],
      [VIEW_KEYS.criteria, FINDING_CRITERIA],
      ['ticket-note-0', FINDING_NOTES[0]],
      ['ticket-note-1', FINDING_NOTES[1]],
    ])
    await ui.unmount()
  }
})

test('AC: expanded draws both notes; Show all calls onExpand and Show less onCompact', async ($, on) => {
  const shown: Shown = { ticket: parseTicket('x-ab12', TASK), mode: 'expanded', showToggles: true }
  const pressed = drawView(on, shown)
  for (const surface of SURFACES) {
    shown.mode = 'expanded'
    pressed.length = 0
    const ui = await mountView($, surface)
    expect(await markdowns(ui)).toEqual([
      [VIEW_KEYS.description, TASK_DESCRIPTION],
      [VIEW_KEYS.criteria, TASK_CRITERIA],
      ['ticket-note-0', TASK_NOTES[0]],
      ['ticket-note-1', TASK_NOTES[1]],
    ])
    expect(await texts(ui)).toEqual(['x-ab12', 'open · task · P2', 'Draw the widget', 'parent x-cd34', '2 notes'])
    expect(await buttons(ui)).toEqual([[VIEW_KEYS.showLess, 'Show less']])
    await ui.press({ key: VIEW_KEYS.showLess })
    expect(pressed).toEqual(['compact'])
    shown.mode = 'compact'
    await ui.redraw()
    expect(await buttons(ui)).toEqual([[VIEW_KEYS.showAll, 'Show all']])
    await ui.press({ key: VIEW_KEYS.showAll })
    expect(pressed).toEqual(['compact', 'expand'])
    await ui.unmount()
  }
})

test('AC: without showToggles neither Show all nor Show less is drawn', async ($, on) => {
  const shown: Shown = { ticket: parseTicket('x-ab12', TASK), mode: 'compact' }
  drawView(on, shown)
  for (const surface of SURFACES) {
    for (const mode of ['compact', 'expanded'] as const) {
      shown.mode = mode
      const ui = await mountView($, surface)
      expect(await ui.findAll({ type: 'Button' })).toEqual([])
      expect(await ui.find({ type: 'Text', text: '2 notes' })).toBeDefined()
      expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(mode === 'expanded' ? 4 : 2)
      await ui.unmount()
    }
  }
})

test('AC: collapsed is one row, a + button then <id> · <status> · <title>, the button calling onCompact', async ($, on) => {
  const pressed = drawView(on, { ticket: parseTicket('x-ab12', TASK), mode: 'collapsed', showToggles: true })
  for (const surface of SURFACES) {
    pressed.length = 0
    const ui = await mountView($, surface)
    const drawn = (await ui.drawn()) as Drawn
    expect(drawn).toMatchObject({ type: 'Box', props: { flexDirection: 'row' } })
    expect(drawn.children).toHaveLength(2)
    expect(drawn.children[0]).toMatchObject({ type: 'Button', props: { key: VIEW_KEYS.restore, label: '+' } })
    expect(drawn.children[1]).toMatchObject({ type: 'Text', props: { wrap: 'truncate' }, children: ['x-ab12 · open · Draw the widget'] })
    await ui.press({ key: VIEW_KEYS.restore })
    expect(pressed).toEqual(['compact'])
    await ui.unmount()
  }
})

test('AC: a missing file draws ticket <id>: file not found, one row in every form', async ($, on) => {
  const missing = await readTicket(fake({ env: { TICKETS_DIR: '/view-7/.tickets' } }).$, 'x-ab12')
  const shown: Shown = { ticket: missing, mode: 'compact', showToggles: true }
  drawView(on, shown)
  for (const surface of SURFACES) {
    for (const mode of ['compact', 'expanded', 'collapsed'] as const) {
      shown.mode = mode
      const ui = await mountView($, surface)
      expect(await ui.drawn()).toMatchObject({ type: 'Text', props: { wrap: 'truncate' }, children: ['ticket x-ab12: file not found'] })
      await ui.unmount()
    }
  }
})

test('the collapsed row leaves out a part the ticket lacks, and a view without handlers still draws its buttons', async ($, on) => {
  const bare: Ticket = { ...parseTicket('x-ab12', TASK), status: '' }
  const shown: Shown = { ticket: bare, mode: 'collapsed', showToggles: true, hasNoHandlers: true }
  drawView(on, shown)
  for (const surface of SURFACES) {
    for (const [mode, key] of [['collapsed', VIEW_KEYS.restore], ['compact', VIEW_KEYS.showAll], ['expanded', VIEW_KEYS.showLess]] as const) {
      shown.mode = mode
      const ui = await mountView($, surface)
      if (mode === 'collapsed') expect(await texts(ui)).toEqual(['x-ab12 · Draw the widget'])
      expect(await ui.press({ key })).toEqual({ element: key })
      await ui.unmount()
    }
  }
})

test('a field, title, description or criteria the ticket lacks draws no row', async ($, on) => {
  const bare: Ticket = { id: 'x-ab12', status: '', type: '', priority: '', parent: '', title: '', description: '', criteria: '', notes: ['**2030-03-01T11:00:00Z**\n\nOnly note.'] }
  const shown: Shown = { ticket: bare, mode: 'compact' }
  drawView(on, shown)
  for (const surface of SURFACES) {
    shown.mode = 'compact'
    const ui = await mountView($, surface)
    const drawn = (await ui.drawn()) as Drawn
    // The id alone in the header, then the notes line.
    expect(drawn.children).toHaveLength(2)
    expect(drawn.children[0]?.children).toHaveLength(1)
    expect(await texts(ui)).toEqual(['x-ab12', '1 note'])
    shown.mode = 'expanded'
    await ui.redraw()
    expect(((await ui.drawn()) as Drawn).children).toHaveLength(3)
    await ui.unmount()
  }
})

test('the fields row shows what the ticket has: P<priority> only with a priority', async ($, on) => {
  const shown: Shown = { ticket: { ...parseTicket('x-ab12', TASK), status: '', type: '', priority: '3' }, mode: 'compact' }
  drawView(on, shown)
  for (const surface of SURFACES) {
    shown.ticket = { ...parseTicket('x-ab12', TASK), status: '', type: '', priority: '3' }
    const ui = await mountView($, surface)
    expect((await texts(ui))[1]).toBe('P3')
    shown.ticket = { ...parseTicket('x-ab12', TASK), priority: '', notes: [] }
    await ui.redraw()
    expect(await texts(ui)).toEqual(['x-ab12', 'open · task', 'Draw the widget', 'parent x-cd34', '0 notes'])
    await ui.unmount()
  }
})

test('control characters in the file are dropped, so the tree still draws; tabs and newlines stay', async ($, on) => {
  const dirty: Ticket = {
    id: 'x-ab12\x07',
    status: 'op\x07en',
    type: 'ta\x00sk',
    priority: '2\x7f',
    parent: 'x-cd\x1b[1m34\x1b[0m',
    title: '\x1b[1mDraw\x1b[0m the\twidget\x08',
    description: 'Ran \x1b[32mall\x1b[0m tests\x1b',
    criteria: '## Acceptance Criteria\n\n- it shows\x9b\x9f',
    notes: ['**2030-03-01T11:00:00Z**\n\nOutput: \x1b[31mred\x1b[0m\x0b'],
  }
  const shown: Shown = { ticket: dirty, mode: 'expanded' }
  drawView(on, shown)
  for (const surface of SURFACES) {
    shown.ticket = dirty
    shown.mode = 'expanded'
    const ui = await mountView($, surface)
    expect(await texts(ui)).toEqual(['x-ab12', 'open · task · P2', 'Draw the\twidget', 'parent x-cd34', '1 note'])
    expect(await markdowns(ui)).toEqual([
      [VIEW_KEYS.description, 'Ran all tests'],
      [VIEW_KEYS.criteria, '## Acceptance Criteria\n\n- it shows'],
      ['ticket-note-0', '**2030-03-01T11:00:00Z**\n\nOutput: red'],
    ])
    shown.mode = 'collapsed'
    await ui.redraw()
    expect(await texts(ui)).toEqual(['x-ab12 · open · Draw the\twidget'])
    shown.ticket = { id: 'x-ab12\x07', problem: 'EIO: \x1b[1mbad\x1b[0m read\x00' }
    await ui.redraw()
    expect(await texts(ui)).toEqual(['ticket x-ab12: EIO: bad read'])
    await ui.unmount()
  }
})

test('CSI sequences of any final or intermediate byte go whole', async ($, on) => {
  const shown: Shown = { ticket: { ...parseTicket('x-ab12', TASK), title: 'Draw\x1b[2K the\x1b[?25l widget\x1b[1 q', notes: [] }, mode: 'compact' }
  drawView(on, shown)
  for (const surface of SURFACES) {
    const ui = await mountView($, surface)
    expect((await texts(ui))[2]).toBe('Draw the widget')
    await ui.unmount()
  }
})

test('OSC strings to BEL or ST, an unterminated one to the end of its line, and short escapes go whole', async ($, on) => {
  const title = 'see \x1b]8;;file:///a.ts\x1b\\a.ts\x1b]8;;\x1b\\ and\x1b(B \x1b]0;tab\x07done'
  // A DCS, SOS, PM and APC string each go whole too, then an unterminated OSC stops at its line.
  const description = 'Output:\x1bPq#0\x1b\\\x1bXsos\x1b\\\x1b^pm\x1b\\\x1b_Ga=q\x1b\\\x1b]0;no end\nnext line\x1b=.'
  const shown: Shown = { ticket: { ...parseTicket('x-ab12', TASK), title, description, notes: [] }, mode: 'compact' }
  drawView(on, shown)
  for (const surface of SURFACES) {
    const ui = await mountView($, surface)
    expect((await texts(ui))[2]).toBe('see a.ts and done')
    expect((await markdowns(ui))[0]).toEqual([VIEW_KEYS.description, 'Output:\nnext line.'])
    await ui.unmount()
  }
})

test('escapes at the ends of their final-byte ranges go whole', async ($, on) => {
  // `ESC ( 0` (line drawing) and `ESC ~` end a short escape; `ESC [200~` (bracketed paste) and
  // `ESC [@` end a CSI.
  const shown: Shown = { ticket: { ...parseTicket('x-ab12', TASK), title: 'a\x1b(0b\x1b~c\x1b[200~d\x1b[@e', notes: [] }, mode: 'compact' }
  drawView(on, shown)
  for (const surface of SURFACES) {
    const ui = await mountView($, surface)
    expect((await texts(ui))[2]).toBe('abcde')
    await ui.unmount()
  }
})
