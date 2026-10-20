import type { EngineInterface, FsStat, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { SidePaneError, agentName, agentStatus, closeOwnPanes, exitAgent, isIdle, launch, readSide, updateSide } from './herdr'
import type { Side, SideRecord } from './herdr'
import { forgetRole } from './role'
import { recordSession } from './sessions'
import { decideSwitch, forgetSwitch } from './switch'

// herdr.ts is called by no hook of this task, and a test's own `$` has no env, store, fs or clock,
// so its functions run against a stand-in `$` (as core.test.ts does) whose `process.run` fakes
// herdr: panes with their terminals and agents, JSON answers on stdout, and herdr's errors as JSON
// on stderr with exit status 1. Module variables carry over from test to test, so each stand-in
// starts the role over and gives TICKETS_DIR.

const MAIN = 'w1:p1'
const KEY = `side:${MAIN}`
const DIR = '/repo/.tickets'
const WORKTREE = '/repo/.worktrees/w1'
const ENV: Record<string, string> = { HERDR_ENV: '1', HERDR_PANE_ID: MAIN, TICKETS_DIR: DIR }
const UUID = '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D'
const NEW_ID = UUID.toLowerCase()
const STARTED_OVER = 'x-ab12: earlier conversation not found; started a new one'
const NEEDS_ANSWER = 'x-ab12 needs an answer in the side pane'

const RECORD: SideRecord = { ticketId: 'x-ab12', paneId: 'w1:p2', paneTerminalId: 'term-2', agentName: 'tp-x-ab12' }
const WITH_ACTIVITY: SideRecord = { ...RECORD, activityPaneId: 'w1:p3', activityTerminalId: 'term-3', activityTicketId: 'x-ab12' }

// Foreground processes as herdr lists them: a shell, and Claude's native install, which runs as a
// file named for its version.
const SHELL = { argv: ['-zsh'], argv0: '-zsh', cmdline: '-zsh', name: 'zsh', pid: 100 }
const NATIVE_CLAUDE = { argv: ['claude'], argv0: 'claude', cmdline: 'claude', name: '2.1.302', pid: 101 }

// What a faked command does instead of its work: herdr's error, or a call that never answers in
// time (`$.process.run` rejects).
type Failure = { code: string; message?: string } | 'rejects'
type FakePane = { terminalId: string; agent?: { name: string; status: string } }
type World = {
  env?: Record<string, string>
  root?: string
  folders?: string[]
  files?: string[]
  store?: Record<string, unknown>
  panes?: Record<string, FakePane>
  // What each `agent start` does, in order; one past the list starts the agent.
  starts?: (Failure | 'ok')[]
  // Commands that fail, by `<group> <verb>` or `<group> <verb> <last argument>`
  // (`agent send-keys esc`, `pane close w1:p3`); `uuidgen` for the session id.
  fails?: Record<string, Failure>
  // What `pane split` answers in place of its new pane.
  splitResult?: unknown
  // The process Claude runs as, and how many foreground checks still show it after `/exit`.
  claude?: Record<string, unknown>
  claudeChecksAfterExit?: number
}

const BOOM: Failure = { code: 'server_error', message: 'herdr failed (faked)' }

function answer(result: unknown): ProcessRunResult {
  return { exitCode: 0, stdout: JSON.stringify({ id: 'cli', result }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function refusal(code: string, message = `${code} (faked)`): ProcessRunResult {
  return { exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code, message }, id: 'cli' }), isStdoutTruncated: false, isStderrTruncated: false }
}

function fake(world: World = {}) {
  forgetRole()
  const seen = { runs: [] as string[][], timeouts: [] as (number | undefined)[], toasts: [] as string[], slept: [] as number[], writes: [] as string[] }
  const store = new Map<string, unknown>(Object.entries(world.store ?? {}))
  const panes = new Map<string, FakePane & { claudeLeft?: number }>()
  for (const [id, pane] of Object.entries(world.panes ?? {})) panes.set(id, { ...pane, agent: pane.agent && { ...pane.agent } })
  const starts = [...(world.starts ?? [])]
  // herdr never gives a closed pane's id again: a split takes the next id never used.
  const used = new Set(panes.keys())
  let made = 1

  const failureFor = (label: string, last: string | undefined): Failure | undefined => world.fails?.[`${label} ${last}`] ?? world.fails?.[label]
  const paneInfo = (id: string, pane: FakePane) => ({
    pane_id: id,
    terminal_id: pane.terminalId,
    agent_status: pane.agent?.status ?? 'unknown',
  })
  const agentNamed = (name: string | undefined) => [...panes].find(([, pane]) => pane.agent?.name === name)

  const herdr = (args: string[]): ProcessRunResult => {
    const [group, verb, ...rest] = args
    const label = `${group} ${verb}`
    const failed = failureFor(label, rest.at(-1))
    if (failed === 'rejects') throw new Error(`process.run: herdr ${label} ran past its timeout`)
    if (failed !== undefined && label !== 'agent start') return refusal(failed.code, failed.message)
    switch (label) {
      case 'pane get': {
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
        return answer(world.splitResult ?? { pane: paneInfo(id, pane), type: 'pane_info' })
      }
      case 'pane close':
        return panes.delete(rest[0] ?? '') ? answer({ type: 'ok' }) : refusal('pane_not_found')
      case 'pane process-info': {
        const pane = panes.get(rest[1] ?? '')
        if (!pane) return refusal('pane_not_found')
        const isClaudeThere = pane.agent !== undefined || (pane.claudeLeft ?? 0) > 0
        if (pane.agent === undefined && (pane.claudeLeft ?? 0) > 0) pane.claudeLeft = (pane.claudeLeft ?? 0) - 1
        const foreground = isClaudeThere ? [SHELL, world.claude ?? NATIVE_CLAUDE] : [SHELL]
        return answer({ process_info: { foreground_processes: foreground, pane_id: rest[1] }, type: 'pane_process_info' })
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
        if (verb === 'prompt' && rest[1] === '/exit') {
          pane.agent = undefined
          pane.claudeLeft = world.claudeChecksAfterExit ?? 0
        }
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
    if (argv[0] !== '/usr/bin/uuidgen') return refusal('unknown_command')
    const failed = world.fails?.uuidgen
    if (failed === 'rejects') throw new Error('process.run: uuidgen ran past its timeout')
    if (failed !== undefined) return { exitCode: 1, stdout: '', stderr: `${failed.message ?? failed.code}\n`, isStdoutTruncated: false, isStderrTruncated: false }
    return { exitCode: 0, stdout: `${UUID}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }

  const $ = {
    env: { get: async (name: string) => (world.env ?? ENV)[name] },
    session: { root: async () => world.root ?? '/repo' },
    fs: {
      stat: async (path: string): Promise<FsStat> => {
        if (world.folders?.includes(path)) return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        if (world.files?.includes(path)) return { kind: 'file', size: 0, mtimeMs: 0, isLink: false }
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
      },
    },
    clock: {
      now: async () => 0,
      sleep: async (ms: number) => {
        seen.slept.push(ms)
      },
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
      keys: async () => [...store.keys()],
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

// Each call a stand-in saw, in short: `pane get w1:p2`, `agent start w1:p2 --resume S1`, ...
function steps(f: ReturnType<typeof fake>): string[] {
  return f.seen.runs.map(argv => {
    if (argv[0] === '/usr/bin/uuidgen') return 'uuidgen'
    const [, group, verb, ...rest] = argv
    if (verb === 'start') {
      const args = rest.slice(rest.indexOf('--') + 1)
      return `agent start ${rest[4]} ${args[0]} ${args[1]}`
    }
    if (verb === 'split') return 'pane split'
    if (verb === 'process-info') return `process-info ${rest[1]}`
    if (verb === 'send-keys' || verb === 'prompt') return `${verb} ${rest[1]}`
    if (verb === 'wait') return 'agent wait'
    return `${group} ${verb} ${rest[0]}`
  })
}

// A split right of the main pane, starting in `cwd`, which the pane is also told as its launch
// folder (R4: role.ts tells the pane's own Claude by it).
function splitArgv(cwd: string): string[] {
  const env = ['--env', 'TICKET_PANES_TICKET=x-ab12', '--env', `TICKETS_DIR=${DIR}`, '--env', `TICKET_PANES_CWD=${cwd}`]
  return ['herdr', 'pane', 'split', MAIN, '--direction', 'right', '--ratio', '0.7', '--no-focus', '--cwd', cwd, ...env]
}

// The `--ratio` of each side-pane split a stand-in saw.
function splitRatios(f: ReturnType<typeof fake>): (string | undefined)[] {
  return f.seen.runs.filter(argv => argv[2] === 'split').map(argv => argv[argv.indexOf('--ratio') + 1])
}

function startArgv(paneId: string, session: string[]): string[] {
  return ['herdr', 'agent', 'start', 'tp-x-ab12', '--kind', 'claude', '--pane', paneId, '--timeout', '30000', '--', ...session, '-n', 'ticket x-ab12']
}

async function failure(promise: Promise<unknown>): Promise<SidePaneError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(SidePaneError)
  return error as SidePaneError
}

async function resumable(f: ReturnType<typeof fake>, cwd = WORKTREE): Promise<void> {
  await recordSession(f.$, DIR, 'x-ab12', { sessionId: 'S1', cwd })
}

// ---------- names and errors ----------

test('E3: an agent name is tp- and the id, lowercased, with other characters made - and cut to 32', () => {
  expect(agentName('x-ab12')).toBe('tp-x-ab12')
  expect(agentName('AbC.d_e-AB12')).toBe('tp-abc-d_e-ab12')
  expect(agentName('x y/z')).toBe('tp-x-y-z')
  expect(agentName(`x-${'a'.repeat(40)}`)).toBe(`tp-x-${'a'.repeat(27)}`)
  for (const id of ['x-ab12', 'AbC.d_e-AB12', 'x y/z', `x-${'a'.repeat(40)}`]) expect(agentName(id)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
})

test('a SidePaneError names its step, first in its message', () => {
  const error = new SidePaneError('agent start', 'pane w1:p2 is busy')
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('SidePaneError')
  expect(error.step).toBe('agent start')
  expect(error.message).toBe('agent start: pane w1:p2 is busy')
})

// ---------- launch ----------

test('AC: with no recorded conversation, launch splits right of the main pane and starts a new one', async () => {
  const f = fake()
  expect(await launch(f.$, 'x-ab12')).toStrictEqual({ paneId: 'w1:p2' })
  expect(f.seen.runs).toEqual([['/usr/bin/uuidgen'], splitArgv('/repo'), startArgv('w1:p2', ['--session-id', NEW_ID])])
  expect(f.seen.timeouts).toEqual([10_000, 10_000, 45_000])
  // The record holds the side pane and its terminal id; nothing is written to R3.
  expect([...f.store.keys()]).toEqual([KEY])
  expect(f.store.get(KEY)).toStrictEqual(RECORD)
  expect(f.seen.toasts).toEqual([])
})

test('AC: with a recorded conversation whose folder is there, the split starts in it and the agent resumes it', async () => {
  const f = fake({ folders: [WORKTREE] })
  await resumable(f)
  expect(await launch(f.$, 'x-ab12')).toStrictEqual({ paneId: 'w1:p2' })
  expect(f.seen.runs).toEqual([splitArgv(WORKTREE), startArgv('w1:p2', ['--resume', 'S1'])])
  // `agent start` has no folder of its own.
  expect(f.seen.runs[1]).not.toContain('--cwd')
  expect(f.store.get(`session:${DIR}:x-ab12`)).toStrictEqual({ sessionId: 'S1', cwd: WORKTREE })
  expect(f.store.get(KEY)).toStrictEqual(RECORD)
})

test('a recorded conversation whose folder is gone, or is no folder, is resumed from the session root', async () => {
  for (const world of [{}, { files: [WORKTREE] }]) {
    const f = fake(world)
    await resumable(f)
    await launch(f.$, 'x-ab12')
    expect(f.seen.runs, JSON.stringify(world)).toEqual([splitArgv('/repo'), startArgv('w1:p2', ['--resume', 'S1'])])
  }
})

test('E8: CLAUDE_CODE_PLUGIN_DIRS reaches the side pane when set, and an empty value does not', async () => {
  const set = fake({ env: { ...ENV, CLAUDE_CODE_PLUGIN_DIRS: '/mods/a:/mods/b' } })
  await launch(set.$, 'x-ab12')
  expect(set.seen.runs[1]).toEqual([...splitArgv('/repo'), '--env', 'CLAUDE_CODE_PLUGIN_DIRS=/mods/a:/mods/b'])
  const empty = fake({ env: { ...ENV, CLAUDE_CODE_PLUGIN_DIRS: '' } })
  await launch(empty.$, 'x-ab12')
  expect(empty.seen.runs[1]).toEqual(splitArgv('/repo'))
})

test('AC: a resume that fails other than agent_not_ready closes its pane and starts a new conversation in a fresh one', async () => {
  for (const failed of [{ code: 'agent_exited', message: 'claude exited before it was ready' }, 'rejects'] as const) {
    const f = fake({ folders: [WORKTREE], starts: [failed] })
    await resumable(f)
    expect(await launch(f.$, 'x-ab12')).toStrictEqual({ paneId: 'w1:p3' })
    expect(steps(f), JSON.stringify(failed)).toEqual([
      'pane split',
      'agent start w1:p2 --resume S1',
      'pane close w1:p2',
      'uuidgen',
      'pane split',
      `agent start w1:p3 --session-id ${NEW_ID}`,
    ])
    // The fresh pane splits as the first did.
    expect(f.seen.runs[4]).toEqual(splitArgv(WORKTREE))
    expect(f.seen.toasts).toEqual([STARTED_OVER])
    expect(f.store.get(KEY)).toStrictEqual({ ...RECORD, paneId: 'w1:p3', paneTerminalId: 'term-3' })
    expect([...f.panes.keys()]).toEqual(['w1:p3'])
  }
})

test('AC: agent_not_ready keeps the pane, records it and says the side pane needs an answer', async () => {
  for (const isResuming of [true, false]) {
    const f = fake({ folders: [WORKTREE], starts: [{ code: 'agent_not_ready', message: 'the agent is blocked' }] })
    if (isResuming) await resumable(f)
    expect(await launch(f.$, 'x-ab12')).toStrictEqual({ paneId: 'w1:p2', waiting: true })
    expect(steps(f).filter(s => s.startsWith('pane close')), String(isResuming)).toEqual([])
    expect(steps(f)).toHaveLength(isResuming ? 2 : 3)
    expect(f.store.get(KEY)).toStrictEqual(RECORD)
    expect(f.seen.toasts).toEqual([NEEDS_ANSWER])
  }
})

test('AC: any other failure closes the new pane, records nothing and throws a SidePaneError naming agent start', async () => {
  const f = fake({ starts: [{ code: 'pane_not_shell', message: 'pane w1:p2 is not at a shell prompt' }] })
  const error = await failure(launch(f.$, 'x-ab12'))
  expect(error.step).toBe('agent start')
  expect(error.message).toBe('agent start: pane w1:p2 is not at a shell prompt')
  expect(steps(f)).toEqual(['uuidgen', 'pane split', `agent start w1:p2 --session-id ${NEW_ID}`, 'pane close w1:p2'])
  expect([...f.store.keys()]).toEqual([])
  expect([...f.panes.keys()]).toEqual([])
  expect(f.seen.toasts).toEqual([])
  // A start that never answers counts the same.
  const late = fake({ starts: ['rejects'] })
  expect((await failure(launch(late.$, 'x-ab12'))).message).toBe('agent start: process.run: herdr agent start ran past its timeout')
  expect(steps(late).at(-1)).toBe('pane close w1:p2')
  expect([...late.store.keys()]).toEqual([])
})

test('a new conversation that also fails after a failed resume closes the fresh pane and records nothing', async () => {
  const f = fake({ folders: [WORKTREE], starts: [{ code: 'agent_exited' }, { code: 'pane_not_shell', message: 'not at a shell prompt' }] })
  await resumable(f)
  expect((await failure(launch(f.$, 'x-ab12'))).message).toBe('agent start: not at a shell prompt')
  expect(steps(f)).toEqual([
    'pane split',
    'agent start w1:p2 --resume S1',
    'pane close w1:p2',
    'uuidgen',
    'pane split',
    `agent start w1:p3 --session-id ${NEW_ID}`,
    'pane close w1:p3',
  ])
  expect(f.store.has(KEY)).toBe(false)
  expect([...f.panes.keys()]).toEqual([])
  expect(f.seen.toasts).toEqual([])
})

test('a new conversation that starts on a question after a failed resume says both', async () => {
  const f = fake({ folders: [WORKTREE], starts: [{ code: 'agent_exited' }, { code: 'agent_not_ready' }] })
  await resumable(f)
  expect(await launch(f.$, 'x-ab12')).toStrictEqual({ paneId: 'w1:p3', waiting: true })
  expect(f.seen.toasts).toEqual([STARTED_OVER, NEEDS_ANSWER])
  expect(f.store.get(KEY)).toStrictEqual({ ...RECORD, paneId: 'w1:p3', paneTerminalId: 'term-3' })
})

test('AC: every side-pane split leaves the main pane 0.7, so the side pane is 30% of its width: first open, switch and E13 retry', async () => {
  // herdr's --ratio is the share the split pane keeps (checked live), so 0.7 makes the side 30%.
  const first = fake()
  await launch(first.$, 'x-ab12')
  expect(splitRatios(first)).toEqual(['0.7'])
  // A switch from an idle agent ends it and splits a fresh pane for the clicked ticket.
  forgetSwitch()
  const other: Side = { ticketId: 'x-cd34', paneId: 'w1:p2', paneTerminalId: 'term-2', agentName: 'tp-x-cd34', sideAgentLive: true }
  const switching = fake({ store: { [KEY]: other }, panes: { 'w1:p2': { terminalId: 'term-2', agent: { name: 'tp-x-cd34', status: 'idle' } } } })
  expect(await decideSwitch(switching.$, other, 'x-ab12')).toStrictEqual({ kind: 'opened', paneId: 'w1:p3' })
  expect(steps(switching).filter(step => step === 'pane split')).toHaveLength(1)
  expect(splitRatios(switching)).toEqual(['0.7'])
  // The E13 retry splits twice, the failed resume's pane and the fresh one, at the same width.
  const retry = fake({ folders: [WORKTREE], starts: [{ code: 'agent_exited' }] })
  await resumable(retry)
  await launch(retry.$, 'x-ab12')
  expect(splitRatios(retry)).toEqual(['0.7', '0.7'])
})

test('a split that fails throws a SidePaneError naming pane split, with nothing to close or record', async () => {
  const f = fake({ fails: { 'pane split': { code: 'no_room', message: 'no room to split w1:p1' } } })
  expect((await failure(launch(f.$, 'x-ab12'))).message).toBe('pane split: no room to split w1:p1')
  expect(steps(f)).toEqual(['uuidgen', 'pane split'])
  expect([...f.store.keys()]).toEqual([])
  // A split that names no terminal closes the pane it names; one that names neither has none.
  const half = fake({ splitResult: { pane: { pane_id: 'w1:p9' }, type: 'pane_info' } })
  expect((await failure(launch(half.$, 'x-ab12'))).step).toBe('pane split')
  expect(steps(half)).toEqual(['uuidgen', 'pane split', 'pane close w1:p9'])
  const blank = fake({ splitResult: { type: 'pane_info' } })
  expect((await failure(launch(blank.$, 'x-ab12'))).step).toBe('pane split')
  expect(steps(blank)).toEqual(['uuidgen', 'pane split'])
  expect([...blank.store.keys()]).toEqual([])
  // A terminal with no pane id is no pane to start in.
  const nameless = fake({ splitResult: { pane: { terminal_id: 'term-9' }, type: 'pane_info' } })
  expect((await failure(launch(nameless.$, 'x-ab12'))).step).toBe('pane split')
  expect(steps(nameless)).toEqual(['uuidgen', 'pane split'])
  expect([...nameless.store.keys()]).toEqual([])
})

test('herdr output that is not its JSON reads as the failure it is, by the first line of what it wrote', async () => {
  const f = fake()
  const run = f.$.process.run
  f.$.process.run = async (argv, init) => {
    if (argv[2] === 'split') return { exitCode: 2, stdout: '', stderr: '\nusage: herdr pane split [<pane_id>]\n  more\n', isStdoutTruncated: false, isStderrTruncated: false }
    return run(argv, init)
  }
  expect((await failure(launch(f.$, 'x-ab12'))).message).toBe('pane split: usage: herdr pane split [<pane_id>]')
  const silent = fake()
  const silentRun = silent.$.process.run
  silent.$.process.run = async (argv, init) =>
    argv[0] === 'herdr' ? { exitCode: 3, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } : silentRun(argv, init)
  expect((await failure(launch(silent.$, 'x-ab12'))).message).toBe('pane split: exit status 3')
})

test('E7: the new session id is uuidgen\'s, lowercased; when uuidgen fails nothing is split', async () => {
  for (const failed of [{ code: 'uuidgen', message: 'uuidgen: cannot read the clock' }, 'rejects'] as const) {
    const f = fake({ fails: { uuidgen: failed } })
    const error = await failure(launch(f.$, 'x-ab12'))
    expect(error.step).toBe('uuidgen')
    expect(error.message).toBe(failed === 'rejects' ? 'uuidgen: process.run: uuidgen ran past its timeout' : 'uuidgen: uuidgen: cannot read the clock')
    expect(steps(f)).toEqual(['uuidgen'])
  }
  // A rejection that is no Error is named as it is.
  const odd = fake()
  const oddRun = odd.$.process.run
  odd.$.process.run = async (argv, init) => {
    if (argv[0] === '/usr/bin/uuidgen') throw 'uuidgen is not installed'
    return oddRun(argv, init)
  }
  expect((await failure(launch(odd.$, 'x-ab12'))).message).toBe('uuidgen: uuidgen is not installed')
})

test('uuidgen that fails with nothing on stderr is named by its exit status', async () => {
  const f = fake()
  const run = f.$.process.run
  f.$.process.run = async (argv, init) =>
    argv[0] === '/usr/bin/uuidgen' ? { exitCode: 4, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } : run(argv, init)
  expect((await failure(launch(f.$, 'x-ab12'))).message).toBe('uuidgen: exit status 4')
})

test('launch needs the main session\'s herdr pane and a tickets dir', async () => {
  const outside = fake({ env: { TICKETS_DIR: DIR } })
  expect((await failure(launch(outside.$, 'x-ab12'))).step).toBe('herdr pane')
  expect(outside.seen.runs).toEqual([])
  const untracked = fake({ env: { HERDR_ENV: '1', HERDR_PANE_ID: MAIN }, root: '/untracked' })
  expect((await failure(launch(untracked.$, 'x-ab12'))).step).toBe('tickets dir')
  expect(untracked.seen.runs).toEqual([])
})

test('a launch over another ticket\'s record records the launched ticket and drops the old activity part', async () => {
  const stale: SideRecord = { ticketId: 'x-cd34', paneId: 'w1:p9', paneTerminalId: 'term-9', agentName: 'tp-x-cd34', activityPaneId: 'w1:p8', activityTerminalId: 'term-8', activityTicketId: 'x-cd34' }
  const f = fake({ store: { [KEY]: stale } })
  expect(await launch(f.$, 'x-ab12')).toStrictEqual({ paneId: 'w1:p2' })
  expect(f.store.get(KEY)).toStrictEqual(RECORD)
})

// A stale record of an earlier side pane, with its activity pane: what the record still says while
// a launch's resume fails.
const STALE_PANES: Record<string, FakePane> = { 'w1:p2': { terminalId: 'term-2' }, 'w1:p3': { terminalId: 'term-3' } }

test('AC: before the E13 retry closes the side pane, the recorded activity pane closes while it is ours, and its fields are cleared', async () => {
  const f = fake({ folders: [WORKTREE], store: { [KEY]: WITH_ACTIVITY }, panes: STALE_PANES, starts: [{ code: 'agent_exited' }] })
  await resumable(f)
  expect(await launch(f.$, 'x-ab12')).toStrictEqual({ paneId: 'w1:p5' })
  expect(steps(f)).toEqual([
    'pane split',
    'agent start w1:p4 --resume S1',
    'pane get w1:p3',
    'pane close w1:p3',
    'pane close w1:p4',
    'uuidgen',
    'pane split',
    `agent start w1:p5 --session-id ${NEW_ID}`,
  ])
  expect(f.store.get(KEY)).toStrictEqual({ ...RECORD, paneId: 'w1:p5', paneTerminalId: 'term-5' })
  expect(f.seen.toasts).toEqual([STARTED_OVER])
  // An activity pane that is no longer ours is left open; its fields are cleared all the same.
  const other = fake({
    folders: [WORKTREE],
    store: { [KEY]: WITH_ACTIVITY },
    panes: { ...STALE_PANES, 'w1:p3': { terminalId: 'term-8' } },
    starts: [{ code: 'agent_exited' }],
  })
  await resumable(other)
  await launch(other.$, 'x-ab12')
  expect(steps(other).slice(1, 4)).toEqual(['agent start w1:p4 --resume S1', 'pane get w1:p3', 'pane close w1:p4'])
  expect(other.panes.has('w1:p3')).toBe(true)
  expect(other.store.get(KEY)).toStrictEqual({ ...RECORD, paneId: 'w1:p5', paneTerminalId: 'term-5' })
})

test('before the E13 retry, an activity pane look herdr does not answer leaves that pane open and the retry goes on', async () => {
  for (const failed of ['rejects', BOOM] as const) {
    const f = fake({ folders: [WORKTREE], store: { [KEY]: WITH_ACTIVITY }, panes: STALE_PANES, starts: [{ code: 'agent_exited' }], fails: { 'pane get w1:p3': failed } })
    await resumable(f)
    expect(await launch(f.$, 'x-ab12'), JSON.stringify(failed)).toStrictEqual({ paneId: 'w1:p5' })
    expect(steps(f).slice(1, 4)).toEqual(['agent start w1:p4 --resume S1', 'pane get w1:p3', 'pane close w1:p4'])
    expect(f.panes.has('w1:p3')).toBe(true)
    expect(f.store.get(KEY)).toStrictEqual({ ...RECORD, paneId: 'w1:p5', paneTerminalId: 'term-5' })
    expect(f.seen.toasts).toEqual([STARTED_OVER])
  }
})

test('when the E13 retry cannot split a fresh pane, the record of the closed one goes too', async () => {
  const f = fake({ folders: [WORKTREE], store: { [KEY]: RECORD }, starts: [{ code: 'agent_exited' }] })
  await resumable(f)
  // The first split goes through; the retry's is refused.
  let splits = 0
  const run = f.$.process.run
  f.$.process.run = async (argv, init) => {
    if (argv[2] === 'split' && ++splits === 2) {
      f.seen.runs.push([...argv])
      return { exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'no_room', message: 'no room' } }), isStdoutTruncated: false, isStderrTruncated: false }
    }
    return run(argv, init)
  }
  expect((await failure(launch(f.$, 'x-ab12'))).message).toBe('pane split: no room')
  expect(steps(f)).toEqual(['pane split', 'agent start w1:p2 --resume S1', 'pane close w1:p2', 'uuidgen', 'pane split'])
  expect(f.store.has(KEY)).toBe(false)
  expect([...f.panes.keys()]).toEqual([])
  expect(f.seen.toasts).toEqual([])
})

// ---------- readSide and updateSide ----------

test('AC: a recorded side pane whose terminal no longer matches is dropped from the record, never closed', async () => {
  const gone: Record<string, FakePane>[] = [{ 'w1:p2': { terminalId: 'term-9' } }, {}]
  for (const panes of gone) {
    const f = fake({ store: { [KEY]: RECORD }, panes })
    expect(await readSide(f.$)).toBeUndefined()
    expect(steps(f), JSON.stringify(panes)).toEqual(['pane get w1:p2'])
    expect(f.store.has(KEY)).toBe(false)
    expect([...f.panes.keys()]).toEqual(Object.keys(panes))
  }
})

// `f` with `herdr <group> <verb> <target>` answering `out` in place of the fake's own answer.
function answering(f: ReturnType<typeof fake>, call: string, out: ProcessRunResult): void {
  const run = f.$.process.run
  f.$.process.run = async (argv, init) => {
    if (argv.slice(1, 4).join(' ') === call) {
      f.seen.runs.push([...argv])
      return out
    }
    return run(argv, init)
  }
}

function written(exitCode: number, stdout: string, stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

// Answers to a look that are not herdr's own word on what was asked: a call that rejects, another
// error code, a usage line, output that is not JSON, or JSON with no string where the answer goes.
// Each gives its reason. `failing` is the fake's `fails` key: every call of the kind, or only `call`.
function unanswered(call: string, failing: 'kind' | 'call'): [string, World['fails'], ProcessRunResult | undefined, string][] {
  const [group = '', verb = '', target = ''] = call.split(' ')
  const label = `${group} ${verb}`
  const key = failing === 'kind' ? label : call
  // Where the look reads its answer: the pane's terminal, or the agent's pane.
  const odd = written(0, JSON.stringify({ id: 'cli', result: { [group]: { terminal_id: 3, pane_id: 3 } } }))
  return [
    ['rejects', { [key]: 'rejects' }, undefined, `process.run: herdr ${label} ran past its timeout`],
    ['another code', { [key]: BOOM }, undefined, 'herdr failed (faked)'],
    ['usage line', undefined, written(2, '', `usage: herdr ${label}\n`), `usage: herdr ${label}`],
    ['not JSON', undefined, written(0, `${target}\n`), 'herdr gave no answer it could read'],
    ['no string there', undefined, odd, 'herdr gave no answer it could read'],
  ]
}

test('AC: a side pane look herdr does not answer throws pane get, with the record kept and nothing closed', async () => {
  for (const [label, fails, out, reason] of unanswered('pane get w1:p2', 'kind')) {
    const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { 'w1:p2': { terminalId: 'term-2' }, 'w1:p3': { terminalId: 'term-3' } }, fails })
    if (out !== undefined) answering(f, 'pane get w1:p2', out)
    const error = await failure(readSide(f.$))
    expect(error.step, label).toBe('pane get')
    expect(error.message, label).toBe(`pane get: ${reason}`)
    expect(steps(f), label).toEqual(['pane get w1:p2'])
    expect(f.store.get(KEY), label).toStrictEqual(WITH_ACTIVITY)
    expect(f.seen.writes, label).toEqual([])
    expect([...f.panes.keys()], label).toEqual(['w1:p2', 'w1:p3'])
  }
})

test('AC: with the side pane ours, an activity pane look herdr does not answer throws pane get and keeps the activity fields', async () => {
  for (const [label, fails, out, reason] of unanswered('pane get w1:p3', 'call')) {
    const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { 'w1:p2': { terminalId: 'term-2' }, 'w1:p3': { terminalId: 'term-3' } }, fails })
    if (out !== undefined) answering(f, 'pane get w1:p3', out)
    const error = await failure(readSide(f.$))
    expect(error.message, label).toBe(`pane get: ${reason}`)
    expect(steps(f), label).toEqual(['pane get w1:p2', 'pane get w1:p3'])
    expect(f.store.get(KEY), label).toStrictEqual(WITH_ACTIVITY)
    expect(f.seen.writes, label).toEqual([])
    expect([...f.panes.keys()], label).toEqual(['w1:p2', 'w1:p3'])
  }
  // With the side pane gone, the activity pane is not closed on a guess, and the record stays.
  const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { 'w1:p3': { terminalId: 'term-3' } }, fails: { 'pane get w1:p3': 'rejects' } })
  expect((await failure(readSide(f.$))).step).toBe('pane get')
  expect(steps(f)).toEqual(['pane get w1:p2', 'pane get w1:p3'])
  expect(f.store.get(KEY)).toStrictEqual(WITH_ACTIVITY)
  expect(f.panes.has('w1:p3')).toBe(true)
})

test('AC: with the side pane ours, an agent look herdr does not answer throws agent get, with the record unchanged', async () => {
  const working = { terminalId: 'term-2', agent: { name: 'tp-x-ab12', status: 'working' } }
  for (const [label, fails, out, reason] of unanswered('agent get tp-x-ab12', 'kind')) {
    // An activity pane no longer ours would be dropped from the record: the agent's look comes
    // first, so a look that throws leaves even that unwritten.
    const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { 'w1:p2': working, 'w1:p3': { terminalId: 'term-8' } }, fails })
    if (out !== undefined) answering(f, 'agent get tp-x-ab12', out)
    const error = await failure(readSide(f.$))
    expect(error.step, label).toBe('agent get')
    expect(error.message, label).toBe(`agent get: ${reason}`)
    expect(steps(f), label).toEqual(['pane get w1:p2', 'pane get w1:p3', 'agent get tp-x-ab12'])
    expect(f.store.get(KEY), label).toStrictEqual(WITH_ACTIVITY)
    expect(f.seen.writes, label).toEqual([])
    expect([...f.panes.keys()], label).toEqual(['w1:p2', 'w1:p3'])
  }
})

test('AC: when the side part is dropped, the recorded activity pane is closed while it still matches', async () => {
  const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { 'w1:p3': { terminalId: 'term-3' } } })
  expect(await readSide(f.$)).toBeUndefined()
  expect(steps(f)).toEqual(['pane get w1:p2', 'pane get w1:p3', 'pane close w1:p3'])
  expect(f.store.has(KEY)).toBe(false)
  // One that no longer matches is left open.
  const other = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { 'w1:p3': { terminalId: 'term-8' } } })
  expect(await readSide(other.$)).toBeUndefined()
  expect(steps(other)).toEqual(['pane get w1:p2', 'pane get w1:p3'])
  expect(other.panes.has('w1:p3')).toBe(true)
  expect(other.store.has(KEY)).toBe(false)
})

test('AC: when the side pane matches but agent get does not find the agent in it, sideAgentLive is false', async () => {
  const shell = { terminalId: 'term-2' }
  const absent = fake({ store: { [KEY]: RECORD }, panes: { 'w1:p2': shell } })
  expect(await readSide(absent.$)).toStrictEqual({ ...RECORD, sideAgentLive: false })
  expect(steps(absent)).toEqual(['pane get w1:p2', 'agent get tp-x-ab12'])
  // An agent of that name in another pane is not the side agent.
  const elsewhere = fake({ store: { [KEY]: RECORD }, panes: { 'w1:p2': shell, 'w1:p7': { terminalId: 'term-7', agent: { name: 'tp-x-ab12', status: 'idle' } } } })
  expect((await readSide(elsewhere.$))?.sideAgentLive).toBe(false)
  const live = fake({ store: { [KEY]: RECORD }, panes: { 'w1:p2': { ...shell, agent: { name: 'tp-x-ab12', status: 'working' } } } })
  expect(await readSide(live.$)).toStrictEqual({ ...RECORD, sideAgentLive: true })
  expect(live.seen.writes).toEqual([])
})

test('with the side pane ours, an activity pane no longer ours is dropped from the record and left open', async () => {
  const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { 'w1:p2': { terminalId: 'term-2' }, 'w1:p3': { terminalId: 'term-8' } } })
  expect(await readSide(f.$)).toStrictEqual({ ...RECORD, sideAgentLive: false })
  expect(steps(f)).toEqual(['pane get w1:p2', 'pane get w1:p3', 'agent get tp-x-ab12'])
  expect(f.store.get(KEY)).toStrictEqual(RECORD)
  expect(f.panes.has('w1:p3')).toBe(true)
  // Both ours: the record stands as it was, unwritten.
  const both = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { 'w1:p2': { terminalId: 'term-2' }, 'w1:p3': { terminalId: 'term-3' } } })
  expect(await readSide(both.$)).toStrictEqual({ ...WITH_ACTIVITY, sideAgentLive: false })
  expect(both.seen.writes).toEqual([])
})

test('no record, or a stored value whose side part is not whole, reads as none and asks herdr nothing', async () => {
  expect(await readSide(fake().$)).toBeUndefined()
  for (const key of ['ticketId', 'paneId', 'paneTerminalId', 'agentName']) {
    for (const junk of [{ ...RECORD, [key]: undefined }, { ...RECORD, [key]: 7 }]) {
      const f = fake({ store: { [KEY]: junk }, panes: { 'w1:p2': { terminalId: 'term-2' } } })
      expect(await readSide(f.$), JSON.stringify(junk)).toBeUndefined()
      expect(f.seen.runs).toEqual([])
    }
  }
  for (const junk of [null, 'w1:p2', 7]) expect(await readSide(fake({ store: { [KEY]: junk } }).$)).toBeUndefined()
})

test('an activity part is taken only whole', async () => {
  for (const key of ['activityPaneId', 'activityTerminalId', 'activityTicketId']) {
    const f = fake({ store: { [KEY]: { ...WITH_ACTIVITY, [key]: undefined } } })
    let given: SideRecord | undefined
    await updateSide(f.$, old => {
      given = old
      return old
    })
    expect(given, key).toStrictEqual(RECORD)
    expect(f.store.get(KEY)).toStrictEqual(RECORD)
  }
})

test('a record written while the pane\'s folder was kept (paneCwd) reads and writes back without it', async () => {
  const f = fake({ store: { [KEY]: { ...WITH_ACTIVITY, paneCwd: '/repo' } } })
  let given: SideRecord | undefined
  await updateSide(f.$, old => {
    given = old
    return old
  })
  expect(given).toStrictEqual(WITH_ACTIVITY)
  expect(f.store.get(KEY)).toStrictEqual(WITH_ACTIVITY)
})

test('updateSide writes only the record\'s own fields; undefined, or a record without its side part, removes it', async () => {
  const f = fake()
  const side: Side = { ...WITH_ACTIVITY, sideAgentLive: true }
  expect(await updateSide(f.$, () => side)).toStrictEqual(WITH_ACTIVITY)
  expect(f.store.get(KEY)).toStrictEqual(WITH_ACTIVITY)
  let given: SideRecord | undefined
  await updateSide(f.$, old => {
    given = old
    return old && { ...old, activityTicketId: 'x-cd34' }
  })
  expect(given).toStrictEqual(WITH_ACTIVITY)
  expect(f.store.get(KEY)).toStrictEqual({ ...WITH_ACTIVITY, activityTicketId: 'x-cd34' })
  expect(await updateSide(f.$, () => undefined)).toBeUndefined()
  expect(f.store.has(KEY)).toBe(false)
  await updateSide(f.$, () => RECORD)
  await updateSide(f.$, old => old && ({ ...old, paneTerminalId: undefined } as unknown as SideRecord))
  expect(f.store.has(KEY)).toBe(false)
  expect(f.seen.writes).toEqual([`set ${KEY}`, `set ${KEY}`, `delete ${KEY}`, `set ${KEY}`, `delete ${KEY}`])
})

test('the record is kept under the main session\'s own pane, and needs one', async () => {
  const f = fake({ env: { ...ENV, HERDR_PANE_ID: 'w4:p9' } })
  await updateSide(f.$, () => RECORD)
  expect([...f.store.keys()]).toEqual(['side:w4:p9'])
  expect(await readSide(fake({ env: { TICKETS_DIR: DIR }, store: { [KEY]: RECORD } }).$).catch((e: unknown) => e)).toBeInstanceOf(SidePaneError)
})

// ---------- exitAgent ----------

const BUSY_EXIT = [
  ['agent', 'get', 'tp-x-ab12'],
  ['agent', 'send-keys', 'tp-x-ab12', 'esc'],
  ['agent', 'wait', 'tp-x-ab12', '--until', 'idle', '--until', 'done', '--timeout', '10000'],
  ['agent', 'send-keys', 'tp-x-ab12', 'ctrl+c'],
  ['agent', 'prompt', 'tp-x-ab12', '/exit'],
  ['pane', 'process-info', '--pane', 'w1:p2'],
  ['pane', 'close', 'w1:p2'],
]

function agentPane(status: string): Record<string, FakePane> {
  return { 'w1:p2': { terminalId: 'term-2', agent: { name: 'tp-x-ab12', status } } }
}

test('AC: exitAgent on a busy agent sends esc, waits for it, sends ctrl+c and /exit, and closes the pane', async () => {
  for (const status of ['working', 'blocked', 'unknown']) {
    const f = fake({ panes: agentPane(status) })
    await exitAgent(f.$, 'tp-x-ab12', 'w1:p2')
    expect(
      f.seen.runs.map(argv => argv.slice(1)),
      status,
    ).toEqual(BUSY_EXIT)
    expect(f.seen.timeouts).toEqual([10_000, 10_000, 15_000, 10_000, 10_000, 10_000, 10_000])
    expect(f.panes.has('w1:p2')).toBe(false)
  }
})

test('E6: an idle or done agent is not interrupted or waited for', async () => {
  for (const status of ['idle', 'done']) {
    const f = fake({ panes: agentPane(status) })
    await exitAgent(f.$, 'tp-x-ab12', 'w1:p2')
    expect(steps(f), status).toEqual(['agent get tp-x-ab12', 'send-keys ctrl+c', 'prompt /exit', 'process-info w1:p2', 'pane close w1:p2'])
  }
})

test('E6: idle and done are idle; working, blocked, unknown and a status that could not be read are busy', async () => {
  expect([isIdle('idle'), isIdle('done')]).toEqual([true, true])
  expect([isIdle('working'), isIdle('blocked'), isIdle('unknown'), isIdle(undefined)]).toEqual([false, false, false, false])
  const f = fake({ panes: agentPane('blocked') })
  expect(await agentStatus(f.$, 'tp-x-ab12')).toBe('blocked')
  expect(await agentStatus(f.$, 'tp-x-cd34')).toBeUndefined()
})

test('AC: when /exit or send-keys fail, exitAgent still closes the pane', async () => {
  const cases: Record<string, Failure>[] = [
    { 'agent prompt': BOOM },
    { 'agent send-keys esc': BOOM },
    { 'agent send-keys ctrl+c': BOOM },
    { 'agent send-keys': BOOM, 'agent prompt': BOOM },
    { 'agent wait': BOOM },
    { 'agent get': BOOM },
    { 'agent send-keys': 'rejects', 'agent wait': 'rejects', 'agent prompt': 'rejects', 'agent get': 'rejects' },
  ]
  for (const fails of cases) {
    const f = fake({ panes: agentPane('working'), fails })
    await exitAgent(f.$, 'tp-x-ab12', 'w1:p2')
    expect(steps(f).at(-1), JSON.stringify(fails)).toBe('pane close w1:p2')
    expect(f.panes.has('w1:p2')).toBe(false)
  }
  // An agent herdr no longer finds counts as busy, so it is interrupted too.
  const gone = fake({ panes: { 'w1:p2': { terminalId: 'term-2' } } })
  await exitAgent(gone.$, 'tp-x-ab12', 'w1:p2')
  expect(steps(gone)).toEqual(['agent get tp-x-ab12', 'send-keys esc', 'agent wait', 'send-keys ctrl+c', 'prompt /exit', 'process-info w1:p2', 'pane close w1:p2'])
})

test('E5: the pane closes once claude leaves its foreground, checked up to 10 times 500 ms apart', async () => {
  const checks = (f: ReturnType<typeof fake>) => steps(f).filter(s => s.startsWith('process-info')).length
  const stays = fake({ panes: agentPane('idle'), claudeChecksAfterExit: Number.POSITIVE_INFINITY })
  await exitAgent(stays.$, 'tp-x-ab12', 'w1:p2')
  expect(checks(stays)).toBe(10)
  // 4.5 s of sleep, within the 5 s E5 allows.
  expect(stays.seen.slept).toEqual(Array(9).fill(500))
  expect(steps(stays).at(-1)).toBe('pane close w1:p2')
  const leaves = fake({ panes: agentPane('idle'), claudeChecksAfterExit: 2 })
  await exitAgent(leaves.$, 'tp-x-ab12', 'w1:p2')
  expect(checks(leaves)).toBe(3)
  expect(leaves.seen.slept).toEqual([500, 500])
  // A check that fails ends the wait.
  const blind = fake({ panes: agentPane('idle'), claudeChecksAfterExit: Number.POSITIVE_INFINITY, fails: { 'pane process-info': BOOM } })
  await exitAgent(blind.$, 'tp-x-ab12', 'w1:p2')
  expect(checks(blind)).toBe(1)
  expect(blind.seen.slept).toEqual([])
  expect(steps(blind).at(-1)).toBe('pane close w1:p2')
})

test('claude is told in the foreground by the name it was started as', async () => {
  const cases: [Record<string, unknown>, boolean][] = [
    [NATIVE_CLAUDE, true],
    [{ argv: ['/home/u/.local/bin/claude', '--resume', 'S1'], argv0: null, name: '2.1.302', pid: 7 }, true],
    [{ argv: ['node', '/usr/local/bin/claude', '--resume', 'S1'], argv0: 'node', name: 'node', pid: 7 }, true],
    [{ argv: null, argv0: null, name: 'claude', pid: 7 }, true],
    [{ argv: null, argv0: '/opt/bin/claude', name: '2.1.302', pid: 7 }, true],
    [{ argv: ['less', '-R', 'claude'], argv0: 'less', name: 'less', pid: 7 }, false],
    [{ argv: ['claudette'], argv0: 'claudette', name: 'claudette', pid: 7 }, false],
    [{ argv: ['/opt/claude/bin/run'], argv0: '/opt/claude/bin/run', name: 'run', pid: 7 }, false],
  ]
  for (const [entry, isClaude] of cases) {
    const f = fake({ panes: agentPane('idle'), claude: entry, claudeChecksAfterExit: Number.POSITIVE_INFINITY })
    await exitAgent(f.$, 'tp-x-ab12', 'w1:p2')
    expect(steps(f).filter(s => s.startsWith('process-info')).length, JSON.stringify(entry)).toBe(isClaude ? 10 : 1)
  }
})

// ---------- closeOwnPanes: the side session leaving ----------
// Run as the side session would: its own pane is w1:p2, and the record is under the main session's
// pane, which the side session does not know.

const OWN_PANES: Record<string, FakePane> = { 'w1:p2': { terminalId: 'term-2' }, 'w1:p3': { terminalId: 'term-3' } }

test('AC: leaving closes the activity pane below the side pane while it is ours, then the side pane, and writes nothing', async () => {
  const f = fake({ store: { 'side:w4:p1': WITH_ACTIVITY, [`session:${DIR}:x-ab12`]: { sessionId: 'S1', cwd: '/repo' } }, panes: OWN_PANES })
  await closeOwnPanes(f.$, 'w1:p2')
  expect(steps(f)).toEqual(['pane get w1:p3', 'pane close w1:p3', 'pane close w1:p2'])
  // Each call leaves room in session.end's 1.5 s for the ones after it.
  expect(f.seen.timeouts).toEqual([400, 400, 400])
  expect([...f.panes.keys()]).toEqual([])
  expect(f.seen.writes).toEqual([])
  expect(f.store.get('side:w4:p1')).toStrictEqual(WITH_ACTIVITY)
  expect(f.seen.toasts).toEqual([])
})

test('leaving with no activity pane on record, or no record of this pane, closes only the side pane', async () => {
  const records: Record<string, unknown>[] = [
    {},
    { [KEY]: RECORD },
    // Another side pane's record: its activity pane is not below this one.
    { [KEY]: { ...WITH_ACTIVITY, paneId: 'w1:p9' } },
    // A record-shaped value under a key that holds no side record.
    { [`session:${DIR}:x-ab12`]: WITH_ACTIVITY },
    // An activity part that is not whole.
    { [KEY]: { ...WITH_ACTIVITY, activityTerminalId: undefined } },
  ]
  for (const store of records) {
    const f = fake({ store, panes: OWN_PANES })
    await closeOwnPanes(f.$, 'w1:p2')
    expect(steps(f), JSON.stringify(store)).toEqual(['pane close w1:p2'])
    expect(f.panes.has('w1:p3')).toBe(true)
  }
})

test('leaving finds this pane\'s record among others, under any main session\'s pane', async () => {
  const f = fake({ store: { [KEY]: { ...WITH_ACTIVITY, paneId: 'w1:p9' }, 'side:w4:p1': WITH_ACTIVITY }, panes: OWN_PANES })
  await closeOwnPanes(f.$, 'w1:p2')
  expect(steps(f)).toEqual(['pane get w1:p3', 'pane close w1:p3', 'pane close w1:p2'])
})

test('a stale record naming this pane ahead of the live one leaves its pane open and still lets the live activity pane close', async () => {
  // Left by a main session of an earlier herdr whose pane ids started over: its activity pane id
  // now shows another terminal.
  const stale = { ...WITH_ACTIVITY, activityPaneId: 'w1:p7', activityTerminalId: 'term-old' }
  const f = fake({ store: { 'side:w0:p1': stale, 'side:w4:p1': WITH_ACTIVITY }, panes: { ...OWN_PANES, 'w1:p7': { terminalId: 'term-77' } } })
  await closeOwnPanes(f.$, 'w1:p2')
  expect(steps(f)).toEqual(['pane get w1:p7', 'pane get w1:p3', 'pane close w1:p3', 'pane close w1:p2'])
  expect([...f.panes.keys()]).toEqual(['w1:p7'])
})

test('AC: an activity pane no longer ours is left open, and the side pane still closes', async () => {
  const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: { ...OWN_PANES, 'w1:p3': { terminalId: 'term-8' } } })
  await closeOwnPanes(f.$, 'w1:p2')
  expect(steps(f)).toEqual(['pane get w1:p3', 'pane close w1:p2'])
  expect(f.panes.has('w1:p3')).toBe(true)
})

test('AC: panes already gone (a switch closed them first) are passed over: nothing thrown, nothing toasted', async () => {
  const f = fake({ store: { [KEY]: WITH_ACTIVITY } })
  await closeOwnPanes(f.$, 'w1:p2')
  expect(steps(f)).toEqual(['pane get w1:p3', 'pane close w1:p2'])
  expect(f.seen.toasts).toEqual([])
})

test('a look or close herdr does not answer, or a store that cannot be read, still closes the side pane without throwing', async () => {
  for (const failed of ['rejects', BOOM] as const) {
    const look = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: OWN_PANES, fails: { 'pane get': failed } })
    await closeOwnPanes(look.$, 'w1:p2')
    expect(steps(look), JSON.stringify(failed)).toEqual(['pane get w1:p3', 'pane close w1:p2'])
    expect(look.panes.has('w1:p3')).toBe(true)
    const close = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: OWN_PANES, fails: { 'pane close': failed } })
    await closeOwnPanes(close.$, 'w1:p2')
    expect(steps(close), JSON.stringify(failed)).toEqual(['pane get w1:p3', 'pane close w1:p3', 'pane close w1:p2'])
    expect(close.seen.toasts).toEqual([])
  }
  for (const noun of ['keys', 'get'] as const) {
    const f = fake({ store: { [KEY]: WITH_ACTIVITY }, panes: OWN_PANES })
    f.$.store[noun] = async () => {
      throw new Error('the store is locked (faked)')
    }
    await closeOwnPanes(f.$, 'w1:p2')
    expect(steps(f), noun).toEqual(['pane close w1:p2'])
    expect(f.panes.has('w1:p3')).toBe(true)
  }
})
