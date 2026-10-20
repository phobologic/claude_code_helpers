import type { EngineInterface, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { syncActivity } from './activity'
import type { SideRecord } from './herdr'
import { beginNotices, flushNotices, notify } from './notify'
import { forgetRole } from './role'

// syncActivity is called by no hook of this task (the noun's open will call it), and a test's own
// `$` has no env, store or clock, so it runs against a stand-in `$`, as herdr.test.ts does. Its
// `process.run` fakes R2's lookup (`run-tickets-status --find-ticket <id>`: exit 0 with the run's
// JSON, 1 for none) and herdr: panes with their terminals and agents, JSON answers on stdout, and
// herdr's errors as JSON on stderr with exit status 1. No real herdr or run-tickets-status runs
// (K3). Module variables carry over from test to test, so each stand-in starts the role over.

const MAIN = 'w1:p1'
const KEY = `side:${MAIN}`
const ENV: Record<string, string> = { HERDR_ENV: '1', HERDR_PANE_ID: MAIN }
const ROOT = '/repo/.worktrees/w1'

const SIDE: SideRecord = { ticketId: 'x-ab12', paneId: 'w1:p2', paneTerminalId: 'term-2', paneCwd: '/repo', agentName: 'tp-x-ab12' }
const WITH_ACTIVITY: SideRecord = { ...SIDE, activityPaneId: 'w1:p3', activityTerminalId: 'term-3', activityTicketId: 'x-ab12' }
const WATCH = 'run-tickets-status --ticket x-ab12 --watch 30 wf_1'
const SPLIT_FAILED = 'no run activity for x-ab12: pane split'

// What a faked herdr command does instead of its work: herdr's error, or a call that never answers
// in time (`$.process.run` rejects).
type Failure = { code: string; message?: string } | 'rejects'
// A pane: its terminal, the agent in it, the commands `pane run` gave it, and what
// `pane process-info` lists as its foreground in place of what `ran` gives.
type FakePane = { terminalId: string; agent?: string; ran?: string[]; foreground?: unknown }
type World = {
  env?: Record<string, string>
  store?: Record<string, unknown>
  panes?: Record<string, FakePane>
  // Panes herdr had and closed: it never gives their ids again.
  closed?: string[]
  // The run each ticket is in: the lookup finds it there; a ticket not here is in none.
  runs?: Record<string, string>
  // How the lookup exits, in place of what `runs` gives.
  lookup?: { code: number; stdout?: string; stderr?: string }
  // herdr commands that fail, by `<group> <verb>` (`pane split`, `pane run`).
  fails?: Record<string, Failure>
  // What `pane split` answers as its result in place of its new pane (null included), or the text
  // it prints in place of its JSON.
  splitResult?: unknown
  splitStdout?: string
  // What `$.store.set` rejects with, when it does.
  storeRejection?: unknown
}

const BOOM: Failure = { code: 'server_error', message: 'herdr failed (faked)' }

function exit(code: number, stdout = '', stderr = ''): ProcessRunResult {
  return { exitCode: code, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

function answer(result: unknown): ProcessRunResult {
  return exit(0, JSON.stringify({ id: 'cli', result }))
}

function refusal(code: string, message = `${code} (faked)`): ProcessRunResult {
  return exit(1, '', JSON.stringify({ error: { code, message }, id: 'cli' }))
}

// What `pane process-info` lists as a pane's foreground, in the shape herdr gave it in a scratch
// workspace (herdr on macOS, the watch started by `pane run`): run-tickets-status starts through
// its `#!/usr/bin/env python3` line, so its argv is the interpreter's path, the script's path, then
// the watch's arguments, and its `name` and `argv0` are the interpreter's. After Ctrl-C the
// foreground is the pane's login shell. Paths here are stand-ins for the real ones.
const PYTHON = '/opt/python/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python'
const SCRIPT = '/home/me/.local/bin/run-tickets-status'
const SHELL = { argv: ['-bash'], argv0: 'bash', cmdline: '-bash', cwd: ROOT, name: 'bash', pid: 41 }

function watching(args: string[]): unknown {
  const argv = [PYTHON, SCRIPT, ...args]
  return { argv, argv0: 'Python', cmdline: argv.join(' '), cwd: ROOT, name: 'Python', pid: 42 }
}

// The pane's foreground: the process its last `pane run` started, or its shell when it ran none.
function foregroundOf(pane: FakePane): unknown {
  if ('foreground' in pane) return pane.foreground
  const last = pane.ran?.at(-1)?.split(' ')
  return last?.[0] === 'run-tickets-status' ? [watching(last.slice(1))] : [SHELL]
}

function fake(world: World = {}) {
  forgetRole()
  const seen = { runs: [] as string[][], inits: [] as (ProcessRunInit | undefined)[], toasts: [] as string[], writes: [] as string[] }
  const store = new Map<string, unknown>(Object.entries(world.store ?? {}))
  const panes = new Map<string, FakePane>([[MAIN, { terminalId: 'term-1' }]])
  for (const [id, pane] of Object.entries(world.panes ?? {})) panes.set(id, { ...pane })
  // herdr never gives a closed pane's id again: a split takes the next id never used.
  const used = new Set([...panes.keys(), ...(world.closed ?? [])])
  let made = 1

  const info = (id: string, pane: FakePane) => ({ pane_id: id, terminal_id: pane.terminalId })

  const herdr = (args: string[]): ProcessRunResult => {
    const [group, verb, ...rest] = args
    const label = `${group} ${verb}`
    const failed = world.fails?.[label]
    if (failed === 'rejects') throw new Error(`process.run: herdr ${label} ran past its timeout`)
    if (failed !== undefined) return refusal(failed.code, failed.message)
    const pane = panes.get((label === 'pane process-info' ? rest[1] : rest[0]) ?? '')
    switch (label) {
      case 'pane process-info': {
        if (!pane) return refusal('pane_not_found')
        const processInfo = { foreground_processes: foregroundOf(pane), pane_id: rest[1], shell_pid: 41 }
        return answer({ process_info: processInfo, type: 'pane_process_info' })
      }
      case 'pane get':
        return pane ? answer({ pane: info(rest[0] ?? '', pane), type: 'pane_info' }) : refusal('pane_not_found')
      case 'pane split': {
        if (!pane) return refusal('pane_not_found')
        do {
          made += 1
        } while (used.has(`w1:p${made}`))
        const id = `w1:p${made}`
        const added = { terminalId: `term-${made}` }
        used.add(id)
        panes.set(id, added)
        if (world.splitStdout !== undefined) return exit(0, world.splitStdout)
        return answer('splitResult' in world ? world.splitResult : { pane: info(id, added), type: 'pane_info' })
      }
      case 'pane run':
        if (!pane) return refusal('pane_not_found')
        pane.ran = [...(pane.ran ?? []), rest[1] ?? '']
        return answer({ type: 'ok' })
      case 'pane close':
        return panes.delete(rest[0] ?? '') ? answer({ type: 'ok' }) : refusal('pane_not_found')
      case 'agent get': {
        const found = [...panes].find(([, p]) => p.agent === rest[0])
        if (!found) return refusal('agent_not_found', `agent target ${rest[0]} not found`)
        return answer({ agent: { ...info(found[0], found[1]), name: rest[0], agent_status: 'idle' }, type: 'agent_info' })
      }
      default:
        return refusal('unknown_command')
    }
  }

  const lookup = (id: string): ProcessRunResult => {
    if (world.lookup !== undefined) return exit(world.lookup.code, world.lookup.stdout, world.lookup.stderr)
    const runId = world.runs?.[id]
    return runId === undefined ? exit(1) : exit(0, `${JSON.stringify({ run_id: runId, state: 'running' })}\n`)
  }

  const run = async (argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> => {
    seen.runs.push([...argv])
    seen.inits.push(init)
    if (argv[0] === 'herdr') return herdr(argv.slice(1))
    if (argv[0] === 'run-tickets-status' && argv[1] === '--find-ticket') return lookup(argv[2] ?? '')
    throw new Error(`ENOENT: Executable not found in $PATH: "${argv[0]}"`)
  }

  const $ = {
    env: { get: async (name: string) => (world.env ?? ENV)[name] },
    session: { root: async () => ROOT },
    clock: { now: async () => 0 },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        if (world.storeRejection !== undefined) throw world.storeRejection
        seen.writes.push(`set ${key}`)
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
      delete: async (key: string) => {
        seen.writes.push(`delete ${key}`)
        store.delete(key)
      },
    },
    state: {
      get: async () => ({ value: undefined, version: 0 }),
      set: async () => ({ isSet: true, version: 1 }),
    },
    ui: {
      toast: (text: string) => {
        seen.toasts.push(text)
      },
      log: () => {},
    },
    process: { run },
  }
  return { $: $ as unknown as EngineInterface, seen, store, panes }
}

// Each call a stand-in saw, in short: `find-ticket x-ab12`, `pane split w1:p2`, `pane run w1:p3`,
// `pane process-info w1:p3`.
function steps(f: ReturnType<typeof fake>): string[] {
  return f.seen.runs.map(argv => {
    if (argv[0] !== 'herdr') return `find-ticket ${argv[2]}`
    const [group, verb, ...rest] = argv.slice(1).filter(arg => arg !== '--pane')
    return `${group} ${verb} ${rest[0]}`
  })
}

// The side pane, with its agent, and the activity pane below it running x-ab12's watch of wf_1.
const SIDE_PANE: Record<string, FakePane> = { 'w1:p2': { terminalId: 'term-2', agent: 'tp-x-ab12' } }
const BOTH_PANES: Record<string, FakePane> = { ...SIDE_PANE, 'w1:p3': { terminalId: 'term-3', ran: [WATCH] } }
// What a click sees before it keeps or replaces the activity pane: the lookup, readSide's looks,
// then the activity pane's foreground.
const LOOKED = ['find-ticket x-ab12', 'pane get w1:p2', 'pane get w1:p3', 'agent get tp-x-ab12', 'pane process-info w1:p3']
const REPLACED = [...LOOKED, 'pane close w1:p3', 'pane split w1:p2', 'pane run w1:p4']

// ---------- in a running run ----------

test('AC: a ticket in a running run gets a pane split down from the side pane, unfocused, running its watch, and the record takes it', async () => {
  const f = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE, runs: { 'x-ab12': 'wf_1' } })
  await syncActivity(f.$, 'x-ab12')
  expect(f.seen.runs).toEqual([
    ['run-tickets-status', '--find-ticket', 'x-ab12'],
    ['herdr', 'pane', 'get', 'w1:p2'],
    ['herdr', 'agent', 'get', 'tp-x-ab12'],
    ['herdr', 'pane', 'split', 'w1:p2', '--direction', 'down', '--no-focus', '--cwd', ROOT],
    ['herdr', 'pane', 'run', 'w1:p3', WATCH],
  ])
  // The lookup comes first, in the session root with its own 20 s; each herdr call has 10 s.
  expect(f.seen.inits).toEqual([{ cwd: ROOT, timeoutMs: 20_000 }, ...Array(4).fill({ timeoutMs: 10_000 })])
  expect(f.store.get(KEY)).toStrictEqual(WITH_ACTIVITY)
  expect(f.panes.get('w1:p3')?.ran).toEqual([WATCH])
  expect(f.seen.toasts).toEqual([])
})

test('AC: an activity pane of ours still running the watch of the run the lookup names is kept', async () => {
  const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: BOTH_PANES, runs: { 'x-ab12': 'wf_1' } })
  await syncActivity(f.$, 'x-ab12')
  expect(steps(f)).toEqual(LOOKED)
  expect(f.seen.runs.at(-1)).toEqual(['herdr', 'pane', 'process-info', '--pane', 'w1:p3'])
  expect(f.seen.inits.at(-1)).toEqual({ timeoutMs: 10_000 })
  expect(f.seen.writes).toEqual([])
  expect(f.store.get(KEY)).toStrictEqual(WITH_ACTIVITY)
  expect([...f.panes.keys()]).toEqual([MAIN, 'w1:p2', 'w1:p3'])
  expect(f.seen.toasts).toEqual([])
  // Kept the same way when the watch is one of several foreground processes, and whatever
  // interpreter or script path its argv starts with.
  const among = [SHELL, { argv: ['/usr/bin/python3', 'run-tickets-status', '--ticket', 'x-ab12', '--watch', '30', 'wf_1'] }]
  const several = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { ...SIDE_PANE, 'w1:p3': { terminalId: 'term-3', foreground: among } }, runs: { 'x-ab12': 'wf_1' } })
  await syncActivity(several.$, 'x-ab12')
  expect(steps(several)).toEqual(LOOKED)
  expect(several.seen.writes).toEqual([])
  // And when nothing but the script's path comes before the watch's words (started without the
  // interpreter in argv), so the words are not looked for only at one place.
  const direct = [{ argv: [SCRIPT, '--ticket', 'x-ab12', '--watch', '30', 'wf_1'] }]
  const bare = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { ...SIDE_PANE, 'w1:p3': { terminalId: 'term-3', foreground: direct } }, runs: { 'x-ab12': 'wf_1' } })
  await syncActivity(bare.$, 'x-ab12')
  expect(steps(bare)).toEqual(LOOKED)
  expect(bare.seen.writes).toEqual([])
})

// A replaced activity pane: the old one closed, a new one below the side pane running the watch of
// `runId`, and the record naming it.
function expectReplaced(f: ReturnType<typeof fake>, runId: string, label: string): void {
  expect(steps(f), label).toEqual(REPLACED)
  expect(f.panes.has('w1:p3'), label).toBe(false)
  expect(f.panes.get('w1:p4')?.ran, label).toEqual([`run-tickets-status --ticket x-ab12 --watch 30 ${runId}`])
  expect(f.store.get(KEY), label).toStrictEqual({ ...SIDE, activityPaneId: 'w1:p4', activityTerminalId: 'term-4', activityTicketId: 'x-ab12' })
  expect(f.seen.toasts, label).toEqual([])
}

test('AC: an activity pane of ours watching another run (the run was resumed under a new id) is replaced with a watch of this one', async () => {
  const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: BOTH_PANES, runs: { 'x-ab12': 'wf_2' } })
  await syncActivity(f.$, 'x-ab12')
  expectReplaced(f, 'wf_2', 'wf_2')
})

test('AC: an activity pane of ours whose watch was stopped, or whose foreground herdr cannot show, is replaced', async () => {
  const stopped: [string, FakePane][] = [
    // Ctrl-C in the pane: its login shell is the foreground again (as herdr lists it).
    ['stopped', { terminalId: 'term-3', ran: [WATCH], foreground: [SHELL, { ...SHELL, pid: 40 }] }],
    // A watch of another ticket, or with its words out of order or cut short.
    ['another ticket', { terminalId: 'term-3', foreground: [watching(['--ticket', 'x-cd34', '--watch', '30', 'wf_1'])] }],
    ['out of order', { terminalId: 'term-3', foreground: [watching(['--watch', '30', '--ticket', 'x-ab12', 'wf_1'])] }],
    ['cut short', { terminalId: 'term-3', foreground: [watching(['--ticket', 'x-ab12', '--watch', '30'])] }],
    // The watch's words in what herdr gives besides argv count for nothing.
    ['no argv', { terminalId: 'term-3', foreground: [{ name: 'Python', cmdline: `${PYTHON} ${SCRIPT} --ticket x-ab12 --watch 30 wf_1` }] }],
    ['argv not a list', { terminalId: 'term-3', foreground: [{ argv: `${SCRIPT} --ticket x-ab12 --watch 30 wf_1` }] }],
    ['no processes', { terminalId: 'term-3', foreground: [] }],
    ['processes not a list', { terminalId: 'term-3', foreground: { argv: [SCRIPT, '--ticket', 'x-ab12', '--watch', '30', 'wf_1'] } }],
  ]
  for (const [label, pane] of stopped) {
    const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { ...SIDE_PANE, 'w1:p3': pane }, runs: { 'x-ab12': 'wf_1' } })
    await syncActivity(f.$, 'x-ab12')
    expectReplaced(f, 'wf_1', label)
  }
  // A look that fails, by herdr's error or by running past its time.
  for (const failed of [BOOM, 'rejects'] as const) {
    const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: BOTH_PANES, runs: { 'x-ab12': 'wf_1' }, fails: { 'pane process-info': failed } })
    await syncActivity(f.$, 'x-ab12')
    expectReplaced(f, 'wf_1', JSON.stringify(failed))
  }
})

test("AC: for another ticket in the same run, the activity pane of ours is replaced with that ticket's", async () => {
  // The side pane shows x-cd34 now; the activity pane below it still shows x-ab12.
  const side: SideRecord = { ...WITH_ACTIVITY, ticketId: 'x-cd34', agentName: 'tp-x-cd34' }
  const panes = { 'w1:p2': { terminalId: 'term-2', agent: 'tp-x-cd34' }, 'w1:p3': { terminalId: 'term-3' } }
  const f = fake({ store: { [KEY]: side }, panes, runs: { 'x-ab12': 'wf_1', 'x-cd34': 'wf_1' } })
  await syncActivity(f.$, 'x-cd34')
  expect(steps(f)).toEqual([
    'find-ticket x-cd34',
    'pane get w1:p2',
    'pane get w1:p3',
    'agent get tp-x-cd34',
    'pane close w1:p3',
    'pane split w1:p2',
    'pane run w1:p4',
  ])
  expect(f.panes.get('w1:p4')?.ran).toEqual(['run-tickets-status --ticket x-cd34 --watch 30 wf_1'])
  expect(f.panes.has('w1:p3')).toBe(false)
  expect(f.store.get(KEY)).toStrictEqual({ ...side, activityPaneId: 'w1:p4', activityTerminalId: 'term-4', activityTicketId: 'x-cd34' })
  expect(f.seen.toasts).toEqual([])
})

test('AC: an activity pane whose terminal no longer matches is never closed; in a run a new one opens below', async () => {
  const moved = { ...SIDE_PANE, 'w1:p3': { terminalId: 'term-8' } }
  // In no run: dropped from the record and left open.
  const none = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: moved })
  await syncActivity(none.$, 'x-ab12')
  expect(steps(none)).toEqual(['find-ticket x-ab12', 'pane get w1:p2', 'pane get w1:p3', 'agent get tp-x-ab12'])
  expect(none.panes.has('w1:p3')).toBe(true)
  expect(none.store.get(KEY)).toStrictEqual(SIDE)
  // In a run, for its own ticket or another: it is not ours to keep or close.
  for (const id of ['x-ab12', 'x-cd34']) {
    const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: moved, runs: { [id]: 'wf_1' } })
    await syncActivity(f.$, id)
    expect(steps(f), id).toEqual([`find-ticket ${id}`, 'pane get w1:p2', 'pane get w1:p3', 'agent get tp-x-ab12', 'pane split w1:p2', 'pane run w1:p4'])
    expect(f.panes.has('w1:p3')).toBe(true)
    expect(f.store.get(KEY)).toStrictEqual({ ...SIDE, activityPaneId: 'w1:p4', activityTerminalId: 'term-4', activityTicketId: id })
  }
  // A pane herdr no longer has counts the same.
  const gone = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: SIDE_PANE, closed: ['w1:p3'], runs: { 'x-ab12': 'wf_1' } })
  await syncActivity(gone.$, 'x-ab12')
  expect(steps(gone).filter(s => s.startsWith('pane close'))).toEqual([])
  expect(gone.store.get(KEY)).toStrictEqual({ ...SIDE, activityPaneId: 'w1:p4', activityTerminalId: 'term-4', activityTicketId: 'x-ab12' })
})

// ---------- in no running run ----------

test('AC: for a ticket in no running run, the activity pane of ours is closed and its fields cleared', async () => {
  for (const id of ['x-ab12', 'x-cd34']) {
    const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: BOTH_PANES })
    await syncActivity(f.$, id)
    expect(steps(f), id).toEqual([`find-ticket ${id}`, 'pane get w1:p2', 'pane get w1:p3', 'agent get tp-x-ab12', 'pane close w1:p3'])
    expect(f.panes.has('w1:p3')).toBe(false)
    expect(f.store.get(KEY)).toStrictEqual(SIDE)
    expect(f.seen.toasts).toEqual([])
  }
})

test('in no running run and with no activity pane, nothing is closed, written or toasted', async () => {
  const f = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE })
  await syncActivity(f.$, 'x-ab12')
  expect(steps(f)).toEqual(['find-ticket x-ab12', 'pane get w1:p2', 'agent get tp-x-ab12'])
  expect(f.seen.writes).toEqual([])
  expect(f.seen.toasts).toEqual([])
})

test('with no side pane on record, or one no longer ours, no activity pane opens and nothing is toasted', async () => {
  const none = fake({ panes: SIDE_PANE, runs: { 'x-ab12': 'wf_1' } })
  await syncActivity(none.$, 'x-ab12')
  expect(steps(none)).toEqual(['find-ticket x-ab12'])
  expect(none.seen.toasts).toEqual([])
  const gone = fake({ store: { [KEY]: SIDE }, runs: { 'x-ab12': 'wf_1' } })
  await syncActivity(gone.$, 'x-ab12')
  expect(steps(gone)).toEqual(['find-ticket x-ab12', 'pane get w1:p2'])
  expect(gone.store.has(KEY)).toBe(false)
  expect(gone.seen.toasts).toEqual([])
})

// ---------- what fails (D17) ----------

test('AC: a split that fails leaves the side pane, records no activity pane and toasts pane split', async () => {
  for (const failed of [{ code: 'no_room', message: 'no room to split w1:p2' }, 'rejects'] as const) {
    const f = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE, runs: { 'x-ab12': 'wf_1' }, fails: { 'pane split': failed } })
    await syncActivity(f.$, 'x-ab12')
    expect(f.seen.toasts, JSON.stringify(failed)).toEqual([SPLIT_FAILED])
    expect(steps(f)).toEqual(['find-ticket x-ab12', 'pane get w1:p2', 'agent get tp-x-ab12', 'pane split w1:p2'])
    expect(f.store.get(KEY)).toStrictEqual(SIDE)
    expect([...f.panes.keys()]).toEqual([MAIN, 'w1:p2'])
  }
  // Replacing another ticket's: that one is closed first, so its fields go too.
  const replacing = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: BOTH_PANES, runs: { 'x-cd34': 'wf_1' }, fails: { 'pane split': BOOM } })
  await syncActivity(replacing.$, 'x-cd34')
  expect(replacing.seen.toasts).toEqual(['no run activity for x-cd34: pane split'])
  expect(steps(replacing).slice(-2)).toEqual(['pane close w1:p3', 'pane split w1:p2'])
  expect(replacing.store.get(KEY)).toStrictEqual(SIDE)
  expect(replacing.panes.has('w1:p2')).toBe(true)
})

test('a split that names no terminal closes the pane it names; one that names no pane closes nothing; both toast pane split', async () => {
  for (const pane of [{ pane_id: 'w1:p9' }, { pane_id: 'w1:p9', terminal_id: 9 }]) {
    const half = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE, runs: { 'x-ab12': 'wf_1' }, splitResult: { pane, type: 'pane_info' } })
    await syncActivity(half.$, 'x-ab12')
    expect(steps(half).slice(-2), JSON.stringify(pane)).toEqual(['pane split w1:p2', 'pane close w1:p9'])
    expect(half.seen.toasts).toEqual([SPLIT_FAILED])
    expect(half.store.get(KEY)).toStrictEqual(SIDE)
  }
  const unnamed: World[] = [
    { splitResult: { type: 'pane_info' } },
    { splitResult: { pane: { terminal_id: 'term-9' }, type: 'pane_info' } },
    { splitResult: { pane: { pane_id: 9, terminal_id: 'term-9' }, type: 'pane_info' } },
    { splitResult: { pane: null, type: 'pane_info' } },
    { splitResult: null },
    { splitStdout: 'split w1:p9' },
  ]
  for (const odd of unnamed) {
    const f = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE, runs: { 'x-ab12': 'wf_1' }, ...odd })
    await syncActivity(f.$, 'x-ab12')
    expect(steps(f).at(-1), JSON.stringify(odd)).toBe('pane split w1:p2')
    expect(f.seen.toasts, JSON.stringify(odd)).toEqual([SPLIT_FAILED])
    expect(f.store.get(KEY)).toStrictEqual(SIDE)
  }
})

test('AC: a lookup that fails opens no activity pane, asks herdr nothing and toasts its error', async () => {
  const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: BOTH_PANES, lookup: { code: 2, stderr: 'not a git repository\n' } })
  await syncActivity(f.$, 'x-ab12')
  expect(f.seen.toasts).toEqual(['no run activity for x-ab12: not a git repository'])
  expect(steps(f)).toEqual(['find-ticket x-ab12'])
  expect(f.seen.writes).toEqual([])
  expect(f.store.get(KEY)).toStrictEqual(WITH_ACTIVITY)
  expect([...f.panes.keys()]).toEqual([MAIN, 'w1:p2', 'w1:p3'])
  // Any error the lookup gives is named as it gives it.
  const odd = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE, lookup: { code: 0, stdout: 'running wf_1' } })
  await syncActivity(odd.$, 'x-ab12')
  expect(odd.seen.toasts).toEqual(['no run activity for x-ab12: run-tickets-status --find-ticket: unexpected output'])
})

test('AC: a side pane look herdr does not answer keeps the record, opens and closes nothing, and toasts pane get', async () => {
  for (const failed of ['rejects', BOOM] as const) {
    const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: BOTH_PANES, runs: { 'x-ab12': 'wf_1' }, fails: { 'pane get': failed } })
    await syncActivity(f.$, 'x-ab12')
    const reason = failed === 'rejects' ? 'process.run: herdr pane get ran past its timeout' : 'herdr failed (faked)'
    expect(f.seen.toasts, JSON.stringify(failed)).toEqual([`no run activity for x-ab12: pane get: ${reason}`])
    expect(steps(f)).toEqual(['find-ticket x-ab12', 'pane get w1:p2'])
    expect(f.store.get(KEY)).toStrictEqual(WITH_ACTIVITY)
    expect(f.seen.writes).toEqual([])
    expect([...f.panes.keys()]).toEqual([MAIN, 'w1:p2', 'w1:p3'])
  }
  // The agent's look the same way, in no run too.
  const f = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE, fails: { 'agent get': 'rejects' } })
  await syncActivity(f.$, 'x-ab12')
  expect(f.seen.toasts).toEqual(['no run activity for x-ab12: agent get: process.run: herdr agent get ran past its timeout'])
  expect(f.store.get(KEY)).toStrictEqual(SIDE)
  expect(f.seen.writes).toEqual([])
})

test('a watch herdr does not take closes the pane split for it, records none and toasts pane run', async () => {
  for (const failed of [{ code: 'input_too_long', message: 'the command is longer than the line limit' }, 'rejects'] as const) {
    const f = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE, runs: { 'x-ab12': 'wf_1' }, fails: { 'pane run': failed } })
    await syncActivity(f.$, 'x-ab12')
    expect(steps(f).slice(-3), JSON.stringify(failed)).toEqual(['pane split w1:p2', 'pane run w1:p3', 'pane close w1:p3'])
    expect(f.panes.has('w1:p3')).toBe(false)
    expect(f.store.get(KEY)).toStrictEqual(SIDE)
    expect(f.seen.toasts).toEqual(['no run activity for x-ab12: pane run'])
  }
})

test('it never rejects: what else fails closes a pane it split and is toasted by its first line', async () => {
  // A record that can't be written: the new pane goes again.
  const unwritable = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE, runs: { 'x-ab12': 'wf_1' }, storeRejection: new Error('\nstore.set: refused (faked)\n    at set (engine)') })
  await syncActivity(unwritable.$, 'x-ab12')
  expect(steps(unwritable).slice(-3)).toEqual(['pane split w1:p2', 'pane run w1:p3', 'pane close w1:p3'])
  expect(unwritable.panes.has('w1:p3')).toBe(false)
  expect(unwritable.seen.toasts).toEqual(['no run activity for x-ab12: store.set: refused (faked)'])
  // A rejection that is no Error is named by its text.
  const odd = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE, runs: { 'x-ab12': 'wf_1' }, storeRejection: 'the store is read-only' })
  await syncActivity(odd.$, 'x-ab12')
  expect(odd.seen.toasts).toEqual(['no run activity for x-ab12: the store is read-only'])
  // A session not in herdr after all: the record can't even be read.
  const outside = fake({ env: {}, store: { [KEY]: SIDE }, panes: SIDE_PANE, runs: { 'x-ab12': 'wf_1' } })
  await syncActivity(outside.$, 'x-ab12')
  expect(steps(outside)).toEqual(['find-ticket x-ab12'])
  expect(outside.seen.toasts).toEqual(['no run activity for x-ab12: herdr pane: this session is not in a herdr pane'])
})

test("inside an open, the toast joins that open's other messages", async () => {
  const f = fake({ store: { [KEY]: SIDE }, panes: SIDE_PANE, runs: { 'x-ab12': 'wf_1' }, fails: { 'pane split': BOOM } })
  beginNotices()
  try {
    notify(f.$, 'x-ab12 needs an answer in the side pane')
    await syncActivity(f.$, 'x-ab12')
    expect(f.seen.toasts).toEqual([])
  } finally {
    flushNotices(f.$)
  }
  expect(f.seen.toasts).toEqual([`x-ab12 needs an answer in the side pane; ${SPLIT_FAILED}`])
})

// ---------- the watch's command line ----------

test('a ticket id the shell would not read as itself goes into the watch quoted; a plain one goes as it is', async () => {
  const cases: [string, string][] = [
    ['a.b_C-12', 'a.b_C-12'],
    ["x'ab", `'x'\\''ab'`],
    ["a'b'c", `'a'\\''b'\\''c'`],
    ['x ab;rm -rf ~', `'x ab;rm -rf ~'`],
    ['$(id)', `'$(id)'`],
    ['x-ab12/..', `'x-ab12/..'`],
  ]
  for (const [id, word] of cases) {
    const f = fake({ store: { [KEY]: { ...SIDE, ticketId: id } }, panes: SIDE_PANE, runs: { [id]: 'wf_1' } })
    await syncActivity(f.$, id)
    expect(f.panes.get('w1:p3')?.ran, id).toEqual([`run-tickets-status --ticket ${word} --watch 30 wf_1`])
  }
})
