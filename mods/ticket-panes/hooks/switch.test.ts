import type { EngineInterface, FsStat, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { SidePaneError } from './herdr'
import type { Side, SideRecord } from './herdr'
import { beginNotices, flushNotices } from './notify'
import { forgetRole } from './role'
import { decideSwitch, forgetSwitch } from './switch'

// switch.ts is called by no hook of this task (the side-pane route calls decideSwitch), and a
// test's own `$` has no env, store, fs or clock, so decideSwitch runs against a stand-in `$`, as
// herdr.test.ts does: its `process.run` fakes herdr's panes, terminals and agents, with JSON
// answers on stdout and herdr's errors as JSON on stderr with exit status 1, and its clock is set
// by the test. Module variables carry over from test to test, so each stand-in starts the role and
// the remembered click over.

const MAIN = 'w1:p1'
const KEY = `side:${MAIN}`
const DIR = '/repo/.tickets'
const ENV: Record<string, string> = { HERDR_ENV: '1', HERDR_PANE_ID: MAIN, TICKETS_DIR: DIR }
const UUID = '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D'
const NEW_ID = UUID.toLowerCase()
const STILL_WORKING = 'x-ab12 is still working; click again to switch anyway'

const RECORD: SideRecord = { ticketId: 'x-ab12', paneId: 'w1:p2', paneTerminalId: 'term-2', agentName: 'tp-x-ab12' }
const SIDE: Side = { ...RECORD, sideAgentLive: true }
const WITH_ACTIVITY: Side = { ...SIDE, activityPaneId: 'w1:p3', activityTerminalId: 'term-3', activityTicketId: 'x-ab12' }

// What a faked command does instead of its work: herdr's error, or a call that never answers in
// time (`$.process.run` rejects).
type Failure = { code: string; message?: string } | 'rejects'
type FakePane = { terminalId: string; agent?: { name: string; status: string } }
type World = {
  panes?: Record<string, FakePane>
  // Commands that fail, by `<group> <verb>` or `<group> <verb> <last argument>`
  // (`agent send-keys esc`, `pane close w1:p3`).
  fails?: Record<string, Failure>
  // What each `agent start` does, in order; one past the list starts the agent.
  starts?: (Failure | 'ok')[]
  // What `pane get` answers instead, by pane: its exit status and stdout.
  paneGets?: Record<string, { exitCode: number; stdout: string }>
}

const BOOM: Failure = { code: 'server_error', message: 'herdr failed (faked)' }

function answer(result: unknown): ProcessRunResult {
  return { exitCode: 0, stdout: JSON.stringify({ id: 'cli', result }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function refusal(code: string, message = `${code} (faked)`): ProcessRunResult {
  return { exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code, message }, id: 'cli' }), isStdoutTruncated: false, isStderrTruncated: false }
}

// The side agent of x-ab12 in its pane with `status`, plus `extra` panes.
function sidePanes(status: string, extra: Record<string, FakePane> = {}): Record<string, FakePane> {
  return { 'w1:p2': { terminalId: 'term-2', agent: { name: 'tp-x-ab12', status } }, ...extra }
}

const ACTIVITY_PANE: Record<string, FakePane> = { 'w1:p3': { terminalId: 'term-3' } }

function fake(world: World = {}) {
  forgetRole()
  forgetSwitch()
  const seen = { runs: [] as string[][], timeouts: [] as (number | undefined)[], toasts: [] as string[], writes: [] as string[] }
  const clock = { now: 0 }
  const store = new Map<string, unknown>()
  const panes = new Map<string, FakePane>()
  for (const [id, pane] of Object.entries(world.panes ?? {})) panes.set(id, { ...pane, agent: pane.agent && { ...pane.agent } })
  const starts = [...(world.starts ?? [])]
  // herdr never gives a closed pane's id again: a split takes the next id never used.
  const used = new Set(panes.keys())
  let made = 1

  const failureFor = (label: string, last: string | undefined): Failure | undefined => world.fails?.[`${label} ${last}`] ?? world.fails?.[label]
  const paneInfo = (id: string, pane: FakePane) => ({ pane_id: id, terminal_id: pane.terminalId, agent_status: pane.agent?.status ?? 'unknown' })
  const agentNamed = (name: string | undefined) => [...panes].find(([, pane]) => pane.agent?.name === name)

  const herdr = (args: string[]): ProcessRunResult => {
    const [group, verb, ...rest] = args
    const label = `${group} ${verb}`
    const failed = failureFor(label, rest.at(-1))
    if (failed === 'rejects') throw new Error(`process.run: herdr ${label} ran past its timeout`)
    if (failed !== undefined && label !== 'agent start') return refusal(failed.code, failed.message)
    switch (label) {
      case 'pane get': {
        const given = world.paneGets?.[rest[0] ?? '']
        if (given) return { ...given, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        const pane = panes.get(rest[0] ?? '')
        return pane ? answer({ pane: paneInfo(rest[0] ?? '', pane), type: 'pane_info' }) : refusal('pane_not_found')
      }
      case 'pane split': {
        do {
          made += 1
        } while (used.has(`w1:p${made}`))
        const id = `w1:p${made}`
        const pane = { terminalId: `term-${made}` }
        used.add(id)
        panes.set(id, pane)
        return answer({ pane: paneInfo(id, pane), type: 'pane_info' })
      }
      case 'pane close':
        return panes.delete(rest[0] ?? '') ? answer({ type: 'ok' }) : refusal('pane_not_found')
      case 'pane process-info': {
        const pane = panes.get(rest[1] ?? '')
        if (!pane) return refusal('pane_not_found')
        return answer({ process_info: { foreground_processes: pane.agent ? [{ argv: ['claude'], argv0: 'claude', name: '2.1.302', pid: 101 }] : [] }, type: 'pane_process_info' })
      }
      case 'agent get': {
        const found = agentNamed(rest[0])
        if (!found) return refusal('agent_not_found', `agent target ${rest[0]} not found`)
        const [id, pane] = found
        return answer({ agent: { ...paneInfo(id, pane), name: rest[0] }, type: 'agent_info' })
      }
      case 'agent start': {
        const pane = panes.get(rest[4] ?? '')
        const outcome = starts.shift() ?? 'ok'
        if (outcome === 'rejects') throw new Error('process.run: herdr agent start ran past its timeout')
        if (outcome === 'ok' && pane) {
          pane.agent = { name: rest[0] ?? '', status: 'idle' }
          return answer({ agent: { ...paneInfo(rest[4] ?? '', pane), name: rest[0] }, argv: ['claude'], type: 'agent_started' })
        }
        if (outcome === 'ok') return refusal('pane_not_found')
        if (outcome.code === 'agent_not_ready' && pane) pane.agent = { name: rest[0] ?? '', status: 'blocked' }
        return refusal(outcome.code, outcome.message)
      }
      case 'agent send-keys':
      case 'agent wait':
      case 'agent prompt': {
        const found = agentNamed(rest[0])
        if (!found) return refusal('agent_not_found')
        const [, pane] = found
        if (verb === 'wait') pane.agent = { name: rest[0] ?? '', status: 'idle' }
        if (verb === 'prompt' && rest[1] === '/exit') pane.agent = undefined
        return answer({ type: 'ok' })
      }
      default:
        return refusal('unknown_command')
    }
  }

  const run = async (argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> => {
    seen.runs.push([...argv])
    seen.timeouts.push(init?.timeoutMs)
    if (init?.timeoutMs === undefined) throw new Error(`${argv.join(' ')}: no timeout given`)
    if (argv[0] === 'herdr') return herdr(argv.slice(1))
    if (argv[0] === '/usr/bin/uuidgen') return { exitCode: 0, stdout: `${UUID}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    return refusal('unknown_command')
  }

  const $ = {
    env: { get: async (name: string) => ENV[name] },
    session: { root: async () => '/repo' },
    fs: {
      stat: async (path: string): Promise<FsStat> => {
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
      },
    },
    clock: {
      now: async () => clock.now,
      sleep: async () => {},
    },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
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
  // The stored record decideSwitch's caller read: the side pane of x-ab12.
  store.set(KEY, RECORD)
  return { $: $ as unknown as EngineInterface, seen, clock, store, panes }
}

// Each call a stand-in saw, in short: `agent get tp-x-ab12`, `pane close w1:p2`, ...
function steps(f: ReturnType<typeof fake>): string[] {
  return f.seen.runs.map(argv => {
    if (argv[0] === '/usr/bin/uuidgen') return 'uuidgen'
    const [, group, verb, ...rest] = argv
    if (verb === 'start') {
      const args = rest.slice(rest.indexOf('--') + 1)
      return `agent start ${rest[0]} ${rest[4]} ${args[0]}`
    }
    if (verb === 'split') return 'pane split'
    if (verb === 'process-info') return `process-info ${rest[1]}`
    if (verb === 'send-keys' || verb === 'prompt') return `${verb} ${rest[1]}`
    if (verb === 'wait') return 'agent wait'
    return `${group} ${verb} ${rest[0]}`
  })
}

// exitAgent's steps on the side agent of x-ab12, idle and busy (E5).
const IDLE_EXIT = ['agent get tp-x-ab12', 'send-keys ctrl+c', 'prompt /exit', 'process-info w1:p2', 'pane close w1:p2']
const BUSY_EXIT = ['agent get tp-x-ab12', 'send-keys esc', 'agent wait', 'send-keys ctrl+c', 'prompt /exit', 'process-info w1:p2', 'pane close w1:p2']
// launch's steps for x-cd34 in a fresh pane, with no conversation recorded for it.
function launchSteps(paneId: string): string[] {
  return ['uuidgen', 'pane split', `agent start tp-x-cd34 ${paneId} --session-id`]
}

// The record launch writes for x-cd34 in `paneId`.
function cd34Record(paneId: string, terminalId: string) {
  return { ticketId: 'x-cd34', paneId, paneTerminalId: terminalId, agentName: 'tp-x-cd34' }
}

// ---------- an idle side agent ----------

test('AC: with the side agent idle, a click on another ticket exits it, closes its pane, launches that ticket and opens', async () => {
  for (const status of ['idle', 'done']) {
    const f = fake({ panes: sidePanes(status) })
    expect(await decideSwitch(f.$, SIDE, 'x-cd34'), status).toStrictEqual({ kind: 'opened', paneId: 'w1:p3' })
    // Its own status read, then exitAgent's (no esc, no wait: E6), then launch's.
    expect(steps(f), status).toEqual(['agent get tp-x-ab12', ...IDLE_EXIT, ...launchSteps('w1:p3')])
    expect(f.panes.has('w1:p2')).toBe(false)
    // The fresh pane carries the clicked ticket (E4), and the record is now its.
    expect(f.seen.runs.find(argv => argv[2] === 'split')).toContain('TICKET_PANES_TICKET=x-cd34')
    expect(f.seen.runs.at(-1)).toEqual(['herdr', 'agent', 'start', 'tp-x-cd34', '--kind', 'claude', '--pane', 'w1:p3', '--timeout', '30000', '--', '--session-id', NEW_ID, '-n', 'ticket x-cd34'])
    expect(f.store.get(KEY)).toStrictEqual(cd34Record('w1:p3', 'term-3'))
    expect(f.seen.toasts).toEqual([])
  }
})

test('the record of the closed panes goes before the launch, so a launch that fails leaves none and its error comes through', async () => {
  const f = fake({ panes: sidePanes('idle'), fails: { 'pane split': { code: 'no_room', message: 'no room to split w1:p1' } } })
  const thrown = await decideSwitch(f.$, SIDE, 'x-cd34').then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(thrown).toBeInstanceOf(SidePaneError)
  expect((thrown as SidePaneError).message).toBe('pane split: no room to split w1:p1')
  expect(steps(f)).toEqual(['agent get tp-x-ab12', ...IDLE_EXIT, 'uuidgen', 'pane split'])
  expect(f.store.has(KEY)).toBe(false)
  expect(f.seen.writes).toEqual([`delete ${KEY}`])
  // A launch that goes through writes its record after that delete.
  const ok = fake({ panes: sidePanes('idle') })
  await decideSwitch(ok.$, SIDE, 'x-cd34')
  expect(ok.seen.writes).toEqual([`delete ${KEY}`, `set ${KEY}`])
})

test('a launch that starts on a question opens and says it is waiting', async () => {
  const f = fake({ panes: sidePanes('idle'), starts: [{ code: 'agent_not_ready', message: 'the agent is blocked' }] })
  expect(await decideSwitch(f.$, SIDE, 'x-cd34')).toStrictEqual({ kind: 'opened', paneId: 'w1:p3', waiting: true })
  expect(f.seen.toasts).toEqual(['x-cd34 needs an answer in the side pane'])
  expect(f.store.get(KEY)).toStrictEqual(cd34Record('w1:p3', 'term-3'))
})

// ---------- a busy side agent ----------

test('AC: with the side agent working, blocked, unknown or not found, a click toasts, closes and opens nothing, and declines', async () => {
  const cases: [string, Record<string, FakePane>][] = [
    ['working', sidePanes('working')],
    ['blocked', sidePanes('blocked')],
    ['unknown', sidePanes('unknown')],
    // herdr no longer finds the agent: its status cannot be read, which counts as busy.
    ['not found', { 'w1:p2': { terminalId: 'term-2' } }],
  ]
  for (const [label, panes] of cases) {
    const f = fake({ panes })
    expect(await decideSwitch(f.$, SIDE, 'x-cd34'), label).toStrictEqual({ kind: 'declined' })
    expect(steps(f), label).toEqual(['agent get tp-x-ab12'])
    expect(f.seen.toasts, label).toEqual([STILL_WORKING])
    expect(f.seen.writes, label).toEqual([])
    expect([...f.panes.keys()], label).toEqual(['w1:p2'])
  }
})

test('the toast names the side pane\'s ticket and goes through the open\'s notices', async () => {
  const f = fake({ panes: sidePanes('working') })
  beginNotices()
  await decideSwitch(f.$, SIDE, 'x-cd34')
  expect(f.seen.toasts).toEqual([])
  flushNotices(f.$)
  expect(f.seen.toasts).toEqual([STILL_WORKING])
  const other = fake({ panes: { 'w1:p2': { terminalId: 'term-2', agent: { name: 'tp-x-ef56', status: 'working' } } } })
  await decideSwitch(other.$, { ...SIDE, ticketId: 'x-ef56', agentName: 'tp-x-ef56' }, 'x-cd34')
  expect(other.seen.toasts).toEqual(['x-ef56 is still working; click again to switch anyway'])
})

test('AC: a second click on that ticket within 15 seconds interrupts the agent, exits it, closes its pane and launches the ticket', async () => {
  const f = fake({ panes: sidePanes('working') })
  f.clock.now = 1_000_000
  expect(await decideSwitch(f.$, SIDE, 'x-cd34')).toStrictEqual({ kind: 'declined' })
  f.clock.now += 10_000
  expect(await decideSwitch(f.$, SIDE, 'x-cd34')).toStrictEqual({ kind: 'opened', paneId: 'w1:p3' })
  expect(steps(f)).toEqual(['agent get tp-x-ab12', 'agent get tp-x-ab12', ...BUSY_EXIT, ...launchSteps('w1:p3')])
  expect(f.panes.has('w1:p2')).toBe(false)
  expect(f.store.get(KEY)).toStrictEqual(cd34Record('w1:p3', 'term-3'))
  // Only the first click toasted.
  expect(f.seen.toasts).toEqual([STILL_WORKING])
})

test('AC: on the second click the pane closes and the ticket launches even when /exit or the keys fail', async () => {
  for (const fails of [{ 'agent prompt': BOOM }, { 'agent send-keys': BOOM, 'agent prompt': 'rejects' }, { 'agent wait': 'rejects' }] as Record<string, Failure>[]) {
    const f = fake({ panes: sidePanes('working'), fails })
    await decideSwitch(f.$, SIDE, 'x-cd34')
    f.clock.now = 5_000
    expect(await decideSwitch(f.$, SIDE, 'x-cd34'), JSON.stringify(fails)).toStrictEqual({ kind: 'opened', paneId: 'w1:p3' })
    expect(steps(f).slice(-4), JSON.stringify(fails)).toEqual(['pane close w1:p2', ...launchSteps('w1:p3')])
    expect(f.panes.has('w1:p2')).toBe(false)
  }
})

test('AC: a click on that ticket 15 seconds or more after the toast toasts again, and that toast starts a new 15 seconds', async () => {
  const late = fake({ panes: sidePanes('working') })
  await decideSwitch(late.$, SIDE, 'x-cd34')
  late.clock.now = 15_000
  expect(await decideSwitch(late.$, SIDE, 'x-cd34')).toStrictEqual({ kind: 'declined' })
  expect(late.seen.toasts).toEqual([STILL_WORKING, STILL_WORKING])
  expect(steps(late)).toEqual(['agent get tp-x-ab12', 'agent get tp-x-ab12'])
  late.clock.now = 15_000 + 14_999
  expect((await decideSwitch(late.$, SIDE, 'x-cd34')).kind).toBe('opened')
  // The last moment within the window switches.
  const edge = fake({ panes: sidePanes('working') })
  await decideSwitch(edge.$, SIDE, 'x-cd34')
  edge.clock.now = 14_999
  expect((await decideSwitch(edge.$, SIDE, 'x-cd34')).kind).toBe('opened')
  expect(edge.seen.toasts).toEqual([STILL_WORKING])
})

test('a click on another ticket after a toast toasts for it, and the earlier ticket needs its own two clicks again', async () => {
  const f = fake({ panes: sidePanes('working') })
  await decideSwitch(f.$, SIDE, 'x-cd34')
  f.clock.now = 1_000
  expect(await decideSwitch(f.$, SIDE, 'x-ef56')).toStrictEqual({ kind: 'declined' })
  f.clock.now = 2_000
  expect(await decideSwitch(f.$, SIDE, 'x-cd34')).toStrictEqual({ kind: 'declined' })
  expect(f.seen.toasts).toEqual([STILL_WORKING, STILL_WORKING, STILL_WORKING])
  expect(f.panes.has('w1:p2')).toBe(true)
})

test('a click timed before the toast, the clock having gone back, toasts again', async () => {
  const f = fake({ panes: sidePanes('working') })
  f.clock.now = 100_000
  await decideSwitch(f.$, SIDE, 'x-cd34')
  f.clock.now = 99_999
  expect(await decideSwitch(f.$, SIDE, 'x-cd34')).toStrictEqual({ kind: 'declined' })
  expect(f.seen.toasts).toEqual([STILL_WORKING, STILL_WORKING])
  // The same moment as the toast is within the window.
  f.clock.now = 99_999
  expect((await decideSwitch(f.$, SIDE, 'x-cd34')).kind).toBe('opened')
})

test('a switch spends the remembered click: a later busy agent toasts again for that ticket', async () => {
  // Declined, then switched to it at once because the agent went idle meanwhile; or switched by the
  // second click.
  for (const isConfirmed of [false, true]) {
    const f = fake({ panes: sidePanes('working') })
    await decideSwitch(f.$, SIDE, 'x-cd34')
    const agent = f.panes.get('w1:p2')?.agent
    if (!isConfirmed && agent) agent.status = 'idle'
    f.clock.now = 1_000
    expect((await decideSwitch(f.$, SIDE, 'x-cd34')).kind, String(isConfirmed)).toBe('opened')
    // Another ticket's busy agent now holds the side pane, and x-cd34 is clicked within the window.
    const later = { ...SIDE, ticketId: 'x-ef56', paneId: 'w1:p3', paneTerminalId: 'term-3', agentName: 'tp-x-ef56' }
    f.panes.set('w1:p3', { terminalId: 'term-3', agent: { name: 'tp-x-ef56', status: 'working' } })
    f.clock.now = 2_000
    expect(await decideSwitch(f.$, later, 'x-cd34'), String(isConfirmed)).toStrictEqual({ kind: 'declined' })
    expect(f.seen.toasts.at(-1)).toBe('x-ef56 is still working; click again to switch anyway')
  }
})

// ---------- the activity pane ----------

test('AC: an activity pane that is ours closes before the side agent is exited', async () => {
  const f = fake({ panes: sidePanes('idle', ACTIVITY_PANE) })
  expect(await decideSwitch(f.$, WITH_ACTIVITY, 'x-cd34')).toStrictEqual({ kind: 'opened', paneId: 'w1:p4' })
  expect(steps(f)).toEqual(['agent get tp-x-ab12', 'pane get w1:p3', 'pane close w1:p3', ...IDLE_EXIT, ...launchSteps('w1:p4')])
  // The look and the close each get herdr's 10 s.
  expect(f.seen.timeouts.slice(1, 3)).toEqual([10_000, 10_000])
  expect([...f.panes.keys()]).toEqual(['w1:p4'])
  // The fresh side pane's record has no activity part.
  expect(f.store.get(KEY)).toStrictEqual(cd34Record('w1:p4', 'term-4'))
  // On a second click past a busy agent too.
  const busy = fake({ panes: sidePanes('working', ACTIVITY_PANE) })
  await decideSwitch(busy.$, WITH_ACTIVITY, 'x-cd34')
  expect(busy.panes.has('w1:p3')).toBe(true)
  await decideSwitch(busy.$, WITH_ACTIVITY, 'x-cd34')
  expect(steps(busy).slice(0, 5)).toEqual(['agent get tp-x-ab12', 'agent get tp-x-ab12', 'pane get w1:p3', 'pane close w1:p3', 'agent get tp-x-ab12'])
})

test('an activity pane that is not ours, or that herdr cannot show, is left open and the switch goes on', async () => {
  const cases: [string, World][] = [
    ['another terminal', { panes: sidePanes('idle', { 'w1:p3': { terminalId: 'term-8' } }) }],
    ['gone', { panes: sidePanes('idle') }],
    ['refused', { panes: sidePanes('idle', ACTIVITY_PANE), fails: { 'pane get': BOOM } }],
    ['rejected', { panes: sidePanes('idle', ACTIVITY_PANE), fails: { 'pane get': 'rejects' } }],
    // A failed exit status counts as failed, whatever it printed.
    ['exit 1', { panes: sidePanes('idle', ACTIVITY_PANE), paneGets: { 'w1:p3': { exitCode: 1, stdout: answer({ pane: { pane_id: 'w1:p3', terminal_id: 'term-3' } }).stdout } } }],
    ['not JSON', { panes: sidePanes('idle', ACTIVITY_PANE), paneGets: { 'w1:p3': { exitCode: 0, stdout: 'pane w1:p3\n' } } }],
    ['no terminal', { panes: sidePanes('idle', ACTIVITY_PANE), paneGets: { 'w1:p3': { exitCode: 0, stdout: answer({ pane: { pane_id: 'w1:p3', terminal_id: 3 } }).stdout } } }],
  ]
  for (const [label, world] of cases) {
    const f = fake(world)
    expect((await decideSwitch(f.$, WITH_ACTIVITY, 'x-cd34')).kind, label).toBe('opened')
    expect(steps(f).slice(0, 3), label).toEqual(['agent get tp-x-ab12', 'pane get w1:p3', 'agent get tp-x-ab12'])
    expect(steps(f), label).not.toContain('pane close w1:p3')
    expect(f.panes.has('w1:p2'), label).toBe(false)
  }
})

test('with no whole activity part nothing is looked up, and a close that fails does not stop the switch', async () => {
  for (const side of [SIDE, { ...WITH_ACTIVITY, activityTerminalId: undefined }, { ...WITH_ACTIVITY, activityPaneId: undefined }]) {
    const f = fake({ panes: sidePanes('idle', ACTIVITY_PANE) })
    await decideSwitch(f.$, side, 'x-cd34')
    expect(steps(f), JSON.stringify(side)).toEqual(['agent get tp-x-ab12', ...IDLE_EXIT, ...launchSteps('w1:p4')])
  }
  for (const failed of [BOOM, 'rejects'] as Failure[]) {
    const f = fake({ panes: sidePanes('idle', ACTIVITY_PANE), fails: { 'pane close w1:p3': failed } })
    expect(await decideSwitch(f.$, WITH_ACTIVITY, 'x-cd34'), JSON.stringify(failed)).toStrictEqual({ kind: 'opened', paneId: 'w1:p4' })
    expect(steps(f), JSON.stringify(failed)).toEqual(['agent get tp-x-ab12', 'pane get w1:p3', 'pane close w1:p3', ...IDLE_EXIT, ...launchSteps('w1:p4')])
  }
})
