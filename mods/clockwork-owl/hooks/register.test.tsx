import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { mergeConfigs, parseConfig, ruleFor, subjectOf } from './config'
import type { Look, Mood } from '../types'
import { frameGrid, lookAt, PEEK_COLUMNS, PEEK_FRAME, pixels, rows, tilt } from './sprites'
import { cleanReply, isLazyPrompt, isTestCommand, LINES } from './voice'

const ROOT = '/repo'

const CELL = {
  plugin: 'clockwork-owl',
  component: 'BesidePrompt',
  requestId: 'beside',
  props: { maxColumns: 20, floatRows: 12, floatColumns: 80, isWorking: false, view: {} },
} as const

type World = {
  files: Map<string, string>
  env: Record<string, string>
  asked: string[]
  reply: string
  /** The owl's mood as it last wrote it. */
  mood: string
}

function world(on: On) {
  const w: World = { files: new Map(), env: {}, asked: [], reply: 'Eight edits to one file. Commitment.', mood: 'idle' }
  const clock = mock.clock(on)
  on('state.set', ($, e, next) => {
    const v = e.value as { mood?: string } | undefined
    if (e.key === 'view' && v?.mood) w.mood = v.mood
    return next(e)
  })
  on('session.cwd', () => ({ value: ROOT }))
  on('env.get', ($, e) => ({ value: w.env[e.name] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'owl' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__clockwork-owl__${e.name}` } }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: w.files.get(e.path) ?? '' }))
  on('model.complete', ($, e) => {
    w.asked.push(String(e.prompt))
    return { value: { isAnswered: true, text: w.reply, usage: { input_tokens: 1, output_tokens: 1 } } } as never
  })
  return { w, clock }
}

async function bubbleText(ui: { find: (q: { type: 'Text'; text?: RegExp }) => Promise<{ text: string } | undefined> }, re: RegExp) {
  return (await ui.find({ type: 'Text', text: re }))?.text
}

test('the owl draws beside the prompt and greets, on terminal and desktop', async ($, on) => {
  world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...CELL, surface })
    expect(await ui.find({ type: 'Text', text: /▀/, in: 'owl' })).toBeDefined()
    const greeting = LINES.greeting.map(l => l.replace(/[.?]/g, '\\$&')).join('|')
    expect(await bubbleText(ui, new RegExp(greeting))).toBeDefined()
    await ui.unmount()
  }
})

test('the owl stays out of a side session', async ($, on) => {
  const { w } = world(on)
  w.env.CLAUDE_SIDE_SESSION = 'ticket-panes'
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...CELL, surface: 'terminal' })
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  await ui.unmount()
})

test('the owl hides when there is no room to float', async ($, on) => {
  world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...CELL, surface: 'terminal', props: { ...CELL.props, floatColumns: 8 } })
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  await ui.unmount()
})

type Outcome = 'ok' | 'error' | 'interrupt' | 'background'

// The engine raises PostToolUse after a call succeeds, PostToolUseFailure after
// it fails (a Bash command's nonzero exit included); the owl watches only those.
// biome-ignore lint/suspicious/noExplicitAny: the test kit's classic noun, typed per event
async function finished($: { classic: any }, tool: string, input: Record<string, unknown>, outcome: Outcome = 'ok') {
  const base = { tool_name: tool, tool_input: input, tool_use_id: 'toolu_1' }
  if (outcome === 'ok') return $.classic.PostToolUse({ ...base, tool_response: { stdout: '', stderr: '', interrupted: false } })
  if (outcome === 'background') {
    return $.classic.PostToolUse({ ...base, tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } })
  }
  return $.classic.PostToolUseFailure({ ...base, error: 'Exit code 1', is_interrupt: outcome === 'interrupt' })
}

test('/owl say asks Haiku with the digest and shows its line; the bubble then clears', async ($, on) => {
  const { w, clock } = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await finished($, 'Edit', { file_path: `${ROOT}/src/app.ts`, old_string: 'a', new_string: 'b' })
  await finished($, 'Edit', { file_path: `${ROOT}/src/app.ts`, old_string: 'b', new_string: 'c' })

  await $.command.run({ command: 'owl', args: 'say' } as never)
  await clock.settle()

  expect(w.asked[0]).toContain('src/app.ts (2 edits)')
  const ui = await $.ui.mount({ ...CELL, surface: 'terminal' })
  expect(await bubbleText(ui, /Commitment/)).toBe('Eight edits to one file. Commitment.')
  await clock.advance(20_000)
  expect(await bubbleText(ui, /Commitment/)).toBeUndefined()
  await ui.unmount()
})

test('while hushed, an explicit /owl say still speaks; /owl hide hides the owl', async ($, on) => {
  const { w, clock } = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'owl', args: 'hush' } as never)

  const ui = await $.ui.mount({ ...CELL, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\w/ })).toBeUndefined()

  await $.command.run({ command: 'owl', args: 'say' } as never)
  await clock.settle()
  expect(w.asked.length).toBe(1)
  expect(await bubbleText(ui, /Commitment/)).toBe('Eight edits to one file. Commitment.')

  await $.command.run({ command: 'owl', args: 'hide' } as never)
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  await ui.unmount()
})

test('a failing test run makes the owl cross, and it calms down after 45 s', async ($, on) => {
  const { w, clock } = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await finished($, 'Bash', { command: 'npm test' }, 'error')
  expect(w.mood).toBe('failed')

  await clock.advance(30_000)
  expect(w.mood).toBe('failed')
  await clock.advance(20_000)
  expect(w.mood).toBe('idle')
})

test('an interrupted or backgrounded test run is no verdict, and other failures leave the mood alone', async ($, on) => {
  const { w } = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await finished($, 'Bash', { command: 'npm test' }, 'interrupt')
  await finished($, 'Bash', { command: 'npm test' }, 'background')
  await finished($, 'Bash', { command: 'ls nowhere' }, 'error')
  expect(w.mood).toBe('idle')
})

test('a repo rule shows its mood while the call runs, then turns by the result', async ($, on) => {
  const { w } = world(on)
  w.files.set(
    `${ROOT}/.claude/owl.json`,
    JSON.stringify({ rules: [{ label: 'flash', match: 'esptool', mood: 'waiting', pass: ['Flashed.'] }], testCommands: false }),
  )
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.command.run({ command: 'owl', args: 'config' } as never))).toContain('1 rules')

  // $.tool.call raises classic.PreToolUse, as a session does before the tool runs.
  await $.tool.call({ tool: 'Bash', command: 'esptool.py write_flash 0x0 fw.bin' })
  expect(w.mood).toBe('waiting')

  await finished($, 'Bash', { command: 'esptool.py write_flash 0x0 fw.bin' })
  expect(w.mood).toBe('happy')
  await finished($, 'Bash', { command: 'esptool.py write_flash 0x0 fw.bin' }, 'error')
  expect(w.mood).toBe('failed')
})

test('with testCommands false, a failing test run leaves the mood alone', async ($, on) => {
  const { w } = world(on)
  w.files.set(`${ROOT}/.claude/owl.json`, JSON.stringify({ testCommands: false }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await finished($, 'Bash', { command: 'npm test' }, 'error')
  expect(w.mood).toBe('idle')
})

// ---------- clicking and the eyes ----------

type Found = { props: Record<string, unknown>; text: string; children: unknown[] }
type Mounted = {
  findAll: (q: { type: string; in: string }) => Promise<Found[]>
  find: (q: { type: string; key?: string; text?: RegExp; in?: string }) => Promise<Found | undefined>
}

/** The sprite the owl's Client drew, as its runs: color/background/text, row by row. */
async function drawn(ui: Mounted): Promise<string> {
  const leaves = (await ui.findAll({ type: 'Text', in: 'owl' })).filter(t => t.children.every(c => typeof c === 'string'))
  return leaves.map(t => `${t.props.color}/${t.props.backgroundColor}/${t.text}`).join('|')
}

/** The same for a sprite drawn straight from the grid. */
function expected(grid: string[]): string {
  return rows(grid)
    .flat()
    .map(r => `${r.color}/${r.backgroundColor}/${r.text}`)
    .join('|')
}

const sprite = (mood: Mood, look: Look) => expected(pixels(mood, look, false))

const isFolded = async (ui: Mounted) => (await ui.find({ type: 'Client', key: 'owl' }))?.props.props?.isFolded

test('clicking the owl slides him off the right edge to peek sideways and hushes him; clicking again brings him back', async ($, on) => {
  const { w, clock } = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...CELL, surface: 'terminal' })
  expect(await bubbleText(ui, /./)).toBeDefined() // the greeting
  expect(await drawn(ui as never)).toBe(sprite('idle', 'center'))

  await ui.pointer({ in: 'owl', type: 'down', x: 5, y: 2, button: 'left' })
  await ui.pointer({ in: 'owl', type: 'up', x: 5, y: 2, button: 'left' })
  expect(await isFolded(ui as never)).toBe(true)
  expect(await bubbleText(ui, /\w/)).toBeUndefined()
  await ui.advance(1000)
  expect(await drawn(ui as never)).toBe(expected(frameGrid('idle', 'center', false, PEEK_FRAME)))

  // Folded, he keeps his remarks to himself; an explicit /owl say brings him back up to say it.
  await $.command.run({ command: 'owl', args: 'say' } as never)
  await clock.settle()
  expect(w.asked.length).toBe(1)
  expect(await isFolded(ui as never)).toBe(false)
  await ui.advance(1000)
  expect(await drawn(ui as never)).toBe(sprite('idle', 'center'))

  await $.command.run({ command: 'owl', args: 'toggle' } as never)
  expect(await isFolded(ui as never)).toBe(true)
  await ui.advance(1000)
  await ui.pointer({ in: 'owl', type: 'down', x: 10, y: 1, button: 'left' })
  expect(await isFolded(ui as never)).toBe(false)
  await ui.unmount()
})

test('he sits flush on the right edge, and a bubble beside him leaves his box the sprite size', async ($, on) => {
  world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...CELL, surface: 'terminal' })
  expect(await bubbleText(ui, /./)).toBeDefined() // the greeting
  const perch = (await ui.find({ key: 'perch' }))?.props
  expect([perch?.right, perch?.width, perch?.height]).toEqual([0, 12, 6])
  await ui.unmount()
})

test('frameGrid: the fold slides him out upright, then back in tilted with both eyes showing', () => {
  const up = frameGrid('idle', 'center', false, 0)
  expect(up).toEqual(pixels('idle', 'center', false))
  const peek = frameGrid('idle', 'center', false, PEEK_FRAME)
  expect(peek.length).toBe(12)
  // Only the last PEEK_COLUMNS columns are painted, and both pupils are in them.
  for (const row of peek) expect(row.slice(0, 12 - PEEK_COLUMNS)).toBe('.'.repeat(12 - PEEK_COLUMNS))
  expect(peek.filter(row => row.includes('P')).length).toBe(2)
  // Tilted, a pointer below has him look down: the pupil sits on each eye's lower edge.
  const down = tilt(pixels('idle', 'down', false, true))
  expect(down[4]?.[4]).toBe('P')
  expect(down[9]?.[4]).toBe('P')
})

test('his pupils follow the pointer over him, and go back when it leaves', async ($, on) => {
  world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...CELL, surface: 'terminal' })

  await ui.pointer({ in: 'owl', type: 'enter', x: 0, y: 2 })
  expect(await drawn(ui as never)).toBe(sprite('idle', 'left'))
  await ui.pointer({ in: 'owl', type: 'move', x: 11, y: 2 })
  expect(await drawn(ui as never)).toBe(sprite('idle', 'right'))
  await ui.pointer({ in: 'owl', type: 'move', x: 6, y: 5 })
  expect(await drawn(ui as never)).toBe(sprite('idle', 'down'))
  await ui.pointer({ in: 'owl', type: 'leave', x: 6, y: 5 })
  expect(await drawn(ui as never)).toBe(sprite('idle', 'center'))
  await ui.unmount()
})

test('lookAt: toward the pointer, or at you between his eyes', () => {
  expect(lookAt(0, 0)).toBe('left')
  expect(lookAt(3, 5)).toBe('left')
  expect(lookAt(8, 0)).toBe('right')
  expect(lookAt(5, 2)).toBe('center')
  expect(lookAt(5, 3)).toBe('down')
})

test('sprites: every mood is 12x12 and failed flares the tufts', () => {
  for (const mood of ['idle', 'working', 'waiting', 'failed', 'happy', 'sleepy'] as const) {
    const grid = pixels(mood, 'center', false)
    expect(grid.length).toBe(12)
    for (const row of grid) expect(row.length).toBe(12)
    expect(grid.join('')).not.toContain('@')
  }
  expect(pixels('failed', 'center', false)[0]).not.toBe(pixels('idle', 'center', false)[0])
  expect(pixels('failed', 'center', false).join('')).toContain('R')
})

test('voice helpers', () => {
  expect(isLazyPrompt('continue')).toBe(true)
  expect(isLazyPrompt('Yes.')).toBe(true)
  expect(isLazyPrompt('continue with the parser, then add tests')).toBe(false)
  expect(isLazyPrompt('/owl')).toBe(false)
  expect(isTestCommand('npm test')).toBe(true)
  expect(isTestCommand('go test ./...')).toBe(true)
  expect(isTestCommand('ls -la')).toBe(false)
  expect(cleanReply('SKIP')).toBeNull()
  expect(cleanReply('"Nice."\nextra')).toBe('Nice.')
  expect(cleanReply('a — b')).toBe('a, b')
})

test('config: keeps what is well formed and reports the rest', () => {
  const { config, problems } = parseConfig(
    JSON.stringify({
      voice: 'A robot owl firmware repo.',
      lines: { greeting: ['Hi.'], nope: ['x'] },
      rules: [{ match: '(' }, { match: 'make flash', mood: 'working', fail: ['Smoke.'] }, { match: 'x', mood: 'grumpy' }],
    }),
  )
  expect(config.voice).toBe('A robot owl firmware repo.')
  expect(config.lines.greeting).toEqual(['Hi.'])
  expect(config.rules.length).toBe(2)
  expect(config.rules[0]?.mood).toBe('working')
  expect(problems.length).toBe(3)
  expect(parseConfig('{').problems).toEqual(['not valid JSON'])
  expect(parseConfig('{"rule": []}').problems).toEqual(['unknown key "rule"'])
})

test('config: rules watch other tools by their subject, MCP tools by prefix', () => {
  const { config } = parseConfig(
    JSON.stringify({
      rules: [
        { label: 'deploy', tool: 'Skill', match: '^deploy$' },
        { label: 'servo', tool: 'Edit', match: 'servo\\.cfg$' },
        { label: 'board', tool: 'mcp__board__*', match: '"port":"usb' },
        { label: 'flash', match: 'esptool' },
      ],
    }),
  )
  expect(ruleFor(config, 'Skill', { skill: 'deploy' })?.label).toBe('deploy')
  expect(ruleFor(config, 'Skill', { skill: 'deploy-docs' })).toBeNull()
  expect(ruleFor(config, 'Edit', { file_path: '/r/servo.cfg' })?.label).toBe('servo')
  expect(ruleFor(config, 'mcp__board__write', { port: 'usb0', tool_use_id: 'x' })?.label).toBe('board')
  expect(ruleFor(config, 'Bash', { command: 'esptool.py write_flash' })?.label).toBe('flash')
  expect(ruleFor(config, 'Bash', { command: 'make deploy' })).toBeNull()
  expect(subjectOf('mcp__board__write', { port: 'usb0', tool_use_id: 'x', agentId: 'a' })).toBe('{"port":"usb0"}')
})

test('config: the local file wins over the committed one', () => {
  const shared = parseConfig(
    JSON.stringify({ voice: 'shared', lines: { greeting: ['A'] }, rules: [{ label: 's', match: 'x' }], testCommands: false }),
  ).config
  const local = parseConfig(JSON.stringify({ voice: 'mine', lines: { greeting: ['B'] }, rules: [{ label: 'l', match: 'x' }] })).config
  const merged = mergeConfigs(shared, local)
  expect(merged.voice).toBe('mine')
  expect(merged.lines.greeting).toEqual(['A', 'B'])
  expect(merged.rules.map(r => r.label)).toEqual(['l', 's'])
  expect(merged.testCommands).toBe(false)
  expect(mergeConfigs(shared, { ...local, testCommands: true }).testCommands).toBe(true)
})

test('owl.local.json is read with owl.json, and /owl config reports both', async ($, on) => {
  const { w } = world(on)
  w.files.set(`${ROOT}/.claude/owl.json`, JSON.stringify({ voice: 'shared' }))
  w.files.set(`${ROOT}/.claude/owl.local.json`, JSON.stringify({ rules: [{ label: 'flash', match: 'esptool' }], oops: 1 }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const text = JSON.stringify(await $.command.run({ command: 'owl', args: 'config' } as never))
  expect(text).toContain('owl.json: ok')
  expect(text).toContain('owl.local.json: problems: unknown key \\"oops\\"')
  expect(text).toContain('voice set')
  expect(text).toContain('flash (Bash: /esptool/)')
})

test('owl_check checks a draft against samples, and with no draft loads the files', async ($, on) => {
  const { w } = world(on)
  // Beneath the plugin, Bash "runs"; the owl's own tool goes on to tool.run.
  on('tool.call', (_, e, next) => (e.tool === 'Bash' ? { result: {} } : next(e)))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const draft = JSON.stringify({ rules: [{ label: 'flash', match: 'esptool', mood: 'grumpy' }] })
  const r1 = await $.tool.call({
    tool: 'mcp__clockwork-owl__owl_check',
    config: draft,
    samples: [
      { tool: 'Bash', input: { command: 'esptool.py write_flash' } },
      { tool: 'Bash', input: { command: 'npm test' } },
      { tool: 'Bash', input: { command: 'ls' } },
    ],
  } as never)
  const t1 = String((r1 as { result?: unknown }).result)
  expect(t1).toContain("rule 1's mood must be one of")
  expect(t1).toContain('Bash "esptool.py write_flash" -> rule "flash"')
  expect(t1).toContain('Bash "npm test" -> no rule; built-in test-run detection reacts')
  expect(t1).toContain('Bash "ls" -> no rule')

  w.files.set(`${ROOT}/.claude/owl.local.json`, JSON.stringify({ rules: [{ label: 'flash', match: 'esptool' }] }))
  const r2 = await $.tool.call({ tool: 'mcp__clockwork-owl__owl_check' } as never)
  expect(String((r2 as { result?: unknown }).result)).toContain('Loaded into the running owl.')

  await finished($, 'Bash', { command: 'esptool.py write_flash' })
  expect(w.mood).toBe('happy')
})
