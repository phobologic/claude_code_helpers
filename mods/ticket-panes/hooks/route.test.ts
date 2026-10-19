import type { EngineInterface, FsStat, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { SidePaneError } from './herdr'
import type { SideRecord } from './herdr'
import { forgetRole } from './role'
import { openSidePane } from './route'

// openSidePane is called by no hook of this task (the noun, Task 2.4, will call it), and a test's
// own `$` has no env, store or clock, so it runs against a stand-in `$`, as herdr.test.ts does: its
// `process.run` fakes herdr, with panes, their terminals and agents, JSON answers on stdout, and
// herdr's errors as JSON on stderr with exit status 1. Module variables carry over from test to
// test, so each stand-in starts the role over. A switch.ts past its stub remembers the click it
// declined, in a module variable too; each stand-in's clock starts an hour after the last one's,
// so no click lands within another test's 15 seconds (D14).

const MAIN = 'w1:p1'
const KEY = `side:${MAIN}`
const DIR = '/repo/.tickets'
const ENV: Record<string, string> = { HERDR_ENV: '1', HERDR_PANE_ID: MAIN, TICKETS_DIR: DIR }
const UUID = '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D'
const NEW_ID = UUID.toLowerCase()

const AB12: SideRecord = { ticketId: 'x-ab12', paneId: 'w1:p2', paneTerminalId: 'term-2', agentName: 'tp-x-ab12' }
const AB12_ACTIVITY: SideRecord = { ...AB12, activityPaneId: 'w1:p3', activityTerminalId: 'term-3', activityTicketId: 'x-ab12' }
const CD34: SideRecord = { ticketId: 'x-cd34', paneId: 'w1:p2', paneTerminalId: 'term-2', agentName: 'tp-x-cd34' }

// Foreground processes as herdr lists them: a shell, and Claude's native install.
const SHELL = { argv: ['-zsh'], argv0: '-zsh', cmdline: '-zsh', name: 'zsh', pid: 100 }
const NATIVE_CLAUDE = { argv: ['claude'], argv0: 'claude', cmdline: 'claude', name: '2.1.302', pid: 101 }

type FakeAgent = { name?: string; status: string }
type FakePane = { terminalId: string; agent?: FakeAgent }
// What a faked command does instead of its work: answers this, or rejects with it.
type Instead = ProcessRunResult | { rejects: unknown }
type World = {
  env?: Record<string, string>
  store?: Record<string, unknown>
  panes?: Record<string, FakePane>
  // What each `agent start` does, in order; one past the list starts the agent.
  starts?: ('ok' | { code: string; message?: string })[]
  // Commands answered otherwise, by `<group> <verb>` or `<group> <verb> <last argument>`.
  instead?: Record<string, Instead>
}

// A stand-in for an agent of another main session: its side agent for x-ab12, in its own pane.
const THEIRS: FakePane = { terminalId: 'term-35', agent: { name: 'tp-x-ab12', status: 'idle' } }

function answer(result: unknown): ProcessRunResult {
  return written(0, JSON.stringify({ id: 'cli', result }), '')
}

function refusal(code: string, message = `${code} (faked)`): ProcessRunResult {
  return written(1, '', JSON.stringify({ error: { code, message }, id: 'cli' }))
}

function written(exitCode: number, stdout: string, stderr: string): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

let clockBase = 0

function fake(world: World = {}) {
  forgetRole()
  clockBase += 3_600_000
  const now = clockBase
  const seen = { runs: [] as string[][], timeouts: [] as (number | undefined)[], toasts: [] as string[] }
  const store = new Map<string, unknown>(Object.entries(world.store ?? {}))
  const panes = new Map<string, FakePane>()
  for (const [id, pane] of Object.entries(world.panes ?? {})) panes.set(id, { ...pane, agent: pane.agent && { ...pane.agent } })
  const starts = [...(world.starts ?? [])]
  // herdr never gives a closed pane's id again: a split takes the next id never used.
  const used = new Set(panes.keys())
  let made = 1

  const info = (id: string, pane: FakePane) => ({ pane_id: id, terminal_id: pane.terminalId, agent_status: pane.agent?.status ?? 'unknown' })
  const agentNamed = (name: string | undefined) => [...panes].find(([, pane]) => name !== undefined && pane.agent?.name === name)
  // As herdr lists agents: an unnamed one has no `name`.
  const listed = () =>
    [...panes].flatMap(([id, pane]) => (pane.agent === undefined ? [] : [{ ...(pane.agent.name === undefined ? {} : { name: pane.agent.name }), ...info(id, pane) }]))

  const herdr = (args: string[]): ProcessRunResult => {
    const [group, verb, ...rest] = args
    const label = `${group} ${verb}`
    const instead = world.instead?.[`${label} ${rest.at(-1)}`] ?? world.instead?.[label]
    if (instead !== undefined && 'rejects' in instead) throw instead.rejects
    if (instead !== undefined) return instead
    switch (label) {
      case 'pane get': {
        const pane = panes.get(rest[0] ?? '')
        return pane ? answer({ pane: info(rest[0] ?? '', pane), type: 'pane_info' }) : refusal('pane_not_found')
      }
      case 'pane split': {
        do {
          made += 1
        } while (used.has(`w1:p${made}`))
        const id = `w1:p${made}`
        const pane = { terminalId: `term-${made}` }
        used.add(id)
        panes.set(id, pane)
        return answer({ pane: info(id, pane), type: 'pane_info' })
      }
      case 'pane close':
        return panes.delete(rest[0] ?? '') ? answer({ type: 'ok' }) : refusal('pane_not_found')
      case 'pane process-info': {
        const pane = panes.get(rest[1] ?? '')
        if (!pane) return refusal('pane_not_found')
        const foreground = pane.agent === undefined ? [SHELL] : [SHELL, NATIVE_CLAUDE]
        return answer({ process_info: { foreground_processes: foreground, pane_id: rest[1] }, type: 'pane_process_info' })
      }
      case 'agent list':
        return answer({ agents: listed(), type: 'agent_list' })
      case 'agent get': {
        const found = agentNamed(rest[0])
        if (!found) return refusal('agent_not_found', `agent target ${rest[0]} not found`)
        const [id, pane] = found
        return answer({ agent: { ...info(id, pane), name: rest[0] }, type: 'agent_info' })
      }
      case 'agent focus':
        return agentNamed(rest[0]) ? answer({ type: 'ok' }) : refusal('agent_not_found', `agent target ${rest[0]} not found`)
      case 'agent start': {
        const [name = '', , , , paneId = ''] = rest
        const pane = panes.get(paneId)
        // herdr names are unique among live agents, and an agent starts only at a shell prompt.
        if (!pane) return refusal('pane_not_found')
        if (agentNamed(name)) return refusal('agent_name_taken', `an agent named ${name} is running`)
        if (pane.agent !== undefined) return refusal('pane_not_shell', `pane ${paneId} is not at a shell prompt`)
        const outcome = starts.shift() ?? 'ok'
        if (outcome === 'ok') {
          pane.agent = { name, status: 'idle' }
          return answer({ agent: { ...info(paneId, pane), name }, argv: ['claude'], type: 'agent_started' })
        }
        if (outcome.code === 'agent_not_ready') pane.agent = { name, status: 'blocked' }
        return refusal(outcome.code, outcome.message)
      }
      case 'agent send-keys':
      case 'agent wait':
      case 'agent prompt': {
        const found = agentNamed(rest[0])
        if (!found) return refusal('agent_not_found')
        const [, pane] = found
        if (verb === 'wait') pane.agent = { name: rest[0], status: 'idle' }
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
    if (argv[0] === 'herdr') return herdr(argv.slice(1))
    if (argv[0] === '/usr/bin/uuidgen') return written(0, `${UUID}\n`, '')
    return refusal('unknown_command')
  }

  const $ = {
    env: { get: async (name: string) => (world.env ?? ENV)[name] },
    session: { root: async () => '/repo' },
    fs: {
      stat: async (path: string): Promise<FsStat> => {
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
      },
    },
    clock: { now: async () => now, sleep: async () => {} },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
      delete: async (key: string) => {
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

// Each call a stand-in saw, in short: `pane get w1:p2`, `pane split x-cd34` (the ticket the pane is
// split for), `agent start w1:p2 tp-x-ab12 --session-id <id>`, ...
function steps(f: ReturnType<typeof fake>): string[] {
  return f.seen.runs.map(argv => {
    if (argv[0] === '/usr/bin/uuidgen') return 'uuidgen'
    const [, group, verb, ...rest] = argv
    if (verb === 'split') return `pane split ${rest.find(arg => arg.startsWith('TICKET_PANES_TICKET='))?.replace('TICKET_PANES_TICKET=', '')}`
    if (verb === 'start') {
      const args = rest.slice(rest.indexOf('--') + 1)
      return `agent start ${rest[4]} ${rest[0]} ${args[0]} ${args[1]}`
    }
    if (verb === 'process-info') return `pane process-info ${rest[1]}`
    return [group, verb, ...rest].join(' ')
  })
}

// The calls that change something in herdr: everything but the looks (`pane get`, `agent get`,
// `agent list`, `pane process-info`).
const CHANGING = /^(uuidgen|pane split|pane close|agent start|agent focus|agent send-keys|agent wait|agent prompt)\b/

function changes(f: ReturnType<typeof fake>): string[] {
  return steps(f).filter(step => CHANGING.test(step))
}

async function failure(promise: Promise<unknown>): Promise<SidePaneError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(SidePaneError)
  return error as SidePaneError
}

// ---------- step 4: no record ----------

test('AC: with no record, a click launches the ticket in a new side pane and returns opened', async () => {
  const f = fake()
  expect(await openSidePane(f.$, 'x-ab12')).toStrictEqual({ kind: 'opened', paneId: 'w1:p2' })
  expect(steps(f)).toEqual(['agent list', 'uuidgen', 'pane split x-ab12', `agent start w1:p2 tp-x-ab12 --session-id ${NEW_ID}`])
  expect(f.store.get(KEY)).toStrictEqual(AB12)
  // A record whose side pane is no longer ours counts as none: readSide drops it, and the pane is
  // left alone.
  const gone = fake({ store: { [KEY]: AB12 }, panes: { 'w1:p2': { terminalId: 'term-9' } } })
  expect(await openSidePane(gone.$, 'x-ab12')).toStrictEqual({ kind: 'opened', paneId: 'w1:p3' })
  expect(steps(gone)).toEqual(['pane get w1:p2', 'agent list', 'uuidgen', 'pane split x-ab12', `agent start w1:p3 tp-x-ab12 --session-id ${NEW_ID}`])
  expect(gone.panes.has('w1:p2')).toBe(true)
})

test('an unnamed agent, or one named for another ticket, is not the clicked ticket\'s', async () => {
  const f = fake({
    panes: { 'w3:p5': { terminalId: 'term-35', agent: { status: 'idle' } }, 'w3:p6': { terminalId: 'term-36', agent: { name: 'tp-x-cd34', status: 'idle' } } },
  })
  expect(await openSidePane(f.$, 'x-ab12')).toStrictEqual({ kind: 'opened', paneId: 'w1:p2' })
  expect(changes(f)).toEqual(['uuidgen', 'pane split x-ab12', `agent start w1:p2 tp-x-ab12 --session-id ${NEW_ID}`])
})

test('an agent list that herdr answers without a list of agents shows none', async () => {
  const answers = [answer({ type: 'agent_list' }), answer({ agents: 'tp-x-ab12', type: 'agent_list' }), written(0, 'not json', '')]
  for (const listing of answers) {
    const f = fake({ instead: { 'agent list': listing } })
    expect(await openSidePane(f.$, 'x-ab12'), listing.stdout).toStrictEqual({ kind: 'opened', paneId: 'w1:p2' })
  }
})

test('a launch that fails rejects with its SidePaneError, for the noun to report (D13)', async () => {
  const f = fake({ instead: { 'pane split': refusal('no_room', 'no room to split w1:p1') } })
  expect((await failure(openSidePane(f.$, 'x-ab12'))).message).toBe('pane split: no room to split w1:p1')
  expect(f.store.has(KEY)).toBe(false)
})

// ---------- step 2: the record shows the ticket ----------

test('AC: with the record showing the ticket and its agent live, a click focuses that agent and returns focused-own', async () => {
  for (const status of ['idle', 'working', 'blocked']) {
    const f = fake({ store: { [KEY]: AB12 }, panes: { 'w1:p2': { terminalId: 'term-2', agent: { name: 'tp-x-ab12', status } } } })
    expect(await openSidePane(f.$, 'x-ab12'), status).toStrictEqual({ kind: 'focused-own', paneId: 'w1:p2' })
    expect(steps(f), status).toEqual(['pane get w1:p2', 'agent get tp-x-ab12', 'agent list', 'agent focus tp-x-ab12'])
    expect(f.seen.timeouts).toEqual([10_000, 10_000, 10_000, 10_000])
    expect(f.store.get(KEY)).toStrictEqual(AB12)
  }
})

test('AC: with the record\'s pane ours and its agent exited, a click starts the agent again in that pane and returns opened', async () => {
  const f = fake({ store: { [KEY]: AB12_ACTIVITY }, panes: { 'w1:p2': { terminalId: 'term-2' }, 'w1:p3': { terminalId: 'term-3' } } })
  expect(await openSidePane(f.$, 'x-ab12')).toStrictEqual({ kind: 'opened', paneId: 'w1:p2' })
  expect(steps(f)).toEqual([
    'pane get w1:p2',
    'pane get w1:p3',
    'agent get tp-x-ab12',
    'agent list',
    'uuidgen',
    `agent start w1:p2 tp-x-ab12 --session-id ${NEW_ID}`,
  ])
  // No split: the record keeps its side pane and its activity pane.
  expect(f.store.get(KEY)).toStrictEqual(AB12_ACTIVITY)
  expect([...f.panes.keys()]).toEqual(['w1:p2', 'w1:p3'])
  // Claude starting there on a question is still opened, and says it waits.
  const asks = fake({ store: { [KEY]: AB12 }, panes: { 'w1:p2': { terminalId: 'term-2' } }, starts: [{ code: 'agent_not_ready' }] })
  expect(await openSidePane(asks.$, 'x-ab12')).toStrictEqual({ kind: 'opened', paneId: 'w1:p2', waiting: true })
  expect(changes(asks)).toEqual(['uuidgen', `agent start w1:p2 tp-x-ab12 --session-id ${NEW_ID}`])
})

test('a focus herdr refuses rejects with a SidePaneError naming agent focus', async () => {
  const live = { 'w1:p2': { terminalId: 'term-2', agent: { name: 'tp-x-ab12', status: 'idle' } } }
  const own = fake({ store: { [KEY]: AB12 }, panes: live, instead: { 'agent focus': refusal('server_error', 'herdr failed (faked)') } })
  const error = await failure(openSidePane(own.$, 'x-ab12'))
  expect(error.step).toBe('agent focus')
  expect(error.message).toBe('agent focus: herdr failed (faked)')
  // The same for an agent outside the record; nothing is launched in its place.
  const foreign = fake({ panes: { 'w3:p5': THEIRS }, instead: { 'agent focus': { rejects: new Error('process.run: herdr agent focus ran past its timeout') } } })
  expect((await failure(openSidePane(foreign.$, 'x-ab12'))).message).toBe('agent focus: process.run: herdr agent focus ran past its timeout')
  expect(changes(foreign)).toEqual(['agent focus tp-x-ab12'])
})

// ---------- step 3: the record shows another ticket ----------

test('AC: with the record showing another ticket whose agent exited, a click closes its panes and launches the clicked one', async () => {
  const f = fake({ store: { [KEY]: AB12_ACTIVITY }, panes: { 'w1:p2': { terminalId: 'term-2' }, 'w1:p3': { terminalId: 'term-3' } } })
  expect(await openSidePane(f.$, 'x-cd34')).toStrictEqual({ kind: 'opened', paneId: 'w1:p4' })
  expect(steps(f)).toEqual([
    'pane get w1:p2',
    'pane get w1:p3',
    'agent get tp-x-ab12',
    'agent list',
    'pane close w1:p3',
    'pane close w1:p2',
    'uuidgen',
    'pane split x-cd34',
    `agent start w1:p4 tp-x-cd34 --session-id ${NEW_ID}`,
  ])
  // Each call has a time of its own: 10 s, and 45 s for launch's agent start.
  expect(f.seen.timeouts).toEqual([...Array(8).fill(10_000), 45_000])
  expect([...f.panes.keys()]).toEqual(['w1:p4'])
  expect(f.store.get(KEY)).toStrictEqual({ ticketId: 'x-cd34', paneId: 'w1:p4', paneTerminalId: 'term-4', agentName: 'tp-x-cd34' })
  // With no activity pane, only the side pane closes.
  const plain = fake({ store: { [KEY]: AB12 }, panes: { 'w1:p2': { terminalId: 'term-2' } } })
  expect(await openSidePane(plain.$, 'x-cd34')).toStrictEqual({ kind: 'opened', paneId: 'w1:p3' })
  expect(changes(plain)).toEqual(['pane close w1:p2', 'uuidgen', 'pane split x-cd34', `agent start w1:p3 tp-x-cd34 --session-id ${NEW_ID}`])
})

test('closing a side pane whose agent exited sends nothing to an agent that took its name since', async () => {
  // Another main session's side agent for x-ab12, started after ours exited, holds the name.
  const theirs: FakePane = { terminalId: 'term-51', agent: { name: 'tp-x-ab12', status: 'working' } }
  const f = fake({ store: { [KEY]: AB12 }, panes: { 'w1:p2': { terminalId: 'term-2' }, 'w5:p1': theirs } })
  expect(await openSidePane(f.$, 'x-cd34')).toStrictEqual({ kind: 'opened', paneId: 'w1:p3' })
  expect(steps(f).filter(step => step.includes('tp-x-ab12') || step.includes('w5:p1'))).toEqual(['agent get tp-x-ab12'])
  expect(f.panes.get('w5:p1')).toStrictEqual(theirs)
})

test('a side pane that will not close still gives way to the clicked ticket, as herdr.ts closes', async () => {
  const f = fake({ store: { [KEY]: AB12 }, panes: { 'w1:p2': { terminalId: 'term-2' } }, instead: { 'pane close': refusal('server_error') } })
  expect(await openSidePane(f.$, 'x-cd34')).toStrictEqual({ kind: 'opened', paneId: 'w1:p3' })
  expect(changes(f)).toEqual(['pane close w1:p2', 'uuidgen', 'pane split x-cd34', `agent start w1:p3 tp-x-cd34 --session-id ${NEW_ID}`])
})

test('AC: with the record showing another ticket whose agent is working, a click returns declined and changes nothing', async () => {
  const live: FakePane = { terminalId: 'term-2', agent: { name: 'tp-x-ab12', status: 'working' } }
  const f = fake({ store: { [KEY]: AB12 }, panes: { 'w1:p2': live } })
  expect(await openSidePane(f.$, 'x-cd34')).toStrictEqual({ kind: 'declined' })
  // True of the stub and of the real decideSwitch, which reads the agent's status and toasts.
  expect(changes(f)).toEqual([])
  expect(f.panes.get('w1:p2')).toStrictEqual(live)
  expect(f.store.get(KEY)).toStrictEqual(AB12)
})

// ---------- step 1: an agent for the ticket outside the record ----------

test('AC: a live agent named for the ticket outside the record is focused, nothing is launched, and the click returns focused-foreign', async () => {
  const cases: [string, World, string][] = [
    ['no record', { panes: { 'w3:p5': THEIRS } }, 'w3:p5'],
    // Our pane shows x-ab12, but its agent exited; the name is held in another pane.
    ['our agent exited', { store: { [KEY]: AB12 }, panes: { 'w1:p2': { terminalId: 'term-2' }, 'w3:p5': THEIRS } }, 'w3:p5'],
    // Our pane shows x-cd34, live: no switch is asked for.
    [
      'another ticket live',
      { store: { [KEY]: CD34 }, panes: { 'w1:p2': { terminalId: 'term-2', agent: { name: 'tp-x-cd34', status: 'working' } }, 'w3:p5': THEIRS } },
      'w3:p5',
    ],
    // An agent of the ticket's name in our side pane, while the record names another agent there.
    ['another name recorded', { store: { [KEY]: CD34 }, panes: { 'w1:p2': { terminalId: 'term-2', agent: { name: 'tp-x-ab12', status: 'idle' } } } }, 'w1:p2'],
  ]
  for (const [label, world, paneId] of cases) {
    const f = fake(world)
    expect(await openSidePane(f.$, 'x-ab12'), label).toStrictEqual({ kind: 'focused-foreign', paneId })
    expect(changes(f), label).toEqual(['agent focus tp-x-ab12'])
    expect(f.store.get(KEY), label).toStrictEqual(world.store?.[KEY])
  }
})

test('an agent list herdr does not give stops the click before anything changes', async () => {
  const cases: [Instead, string][] = [
    [{ rejects: new Error('process.run: herdr agent list ran past its timeout') }, 'agent list: process.run: herdr agent list ran past its timeout'],
    [{ rejects: 'herdr is not installed' }, 'agent list: herdr is not installed'],
    [refusal('server_error', 'herdr failed (faked)'), 'agent list: herdr failed (faked)'],
    [written(2, '', '\nusage: herdr agent list\n  more\n'), 'agent list: usage: herdr agent list'],
    [written(3, '', ''), 'agent list: exit status 3'],
  ]
  for (const [instead, message] of cases) {
    // Without the list, this click would start the agent again in our pane.
    const f = fake({ store: { [KEY]: AB12 }, panes: { 'w1:p2': { terminalId: 'term-2' } }, instead: { 'agent list': instead } })
    const error = await failure(openSidePane(f.$, 'x-ab12'))
    expect(error.step, message).toBe('agent list')
    expect(error.message).toBe(message)
    expect(changes(f), message).toEqual([])
    expect(f.store.get(KEY)).toStrictEqual(AB12)
  }
})

// ---------- R4 ----------

test('a side session, or a session not in herdr, opens no side pane and runs no herdr command', async () => {
  const side = fake({ env: { ...ENV, TICKET_PANES_TICKET: 'x-cd34' } })
  const error = await failure(openSidePane(side.$, 'x-ab12'))
  expect(error.message).toBe('side session: opens no side pane of its own')
  expect(side.seen.runs).toEqual([])
  expect(side.store.size).toBe(0)
  const outside = fake({ env: { TICKETS_DIR: DIR } })
  expect((await failure(openSidePane(outside.$, 'x-ab12'))).step).toBe('herdr pane')
  expect(outside.seen.runs).toEqual([])
})
