import type { EngineInterface, FsStat, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { beginNotices, flushNotices, notify } from './notify'
import { forgetRole, isCountedPrompt, knownRole, resolveRole, role, roleFrom, roleRef } from './role'
import type { Role } from './role'
import { recordSession, recordedSession } from './sessions'
import { isTicket, ticketsDir } from './tickets'

const SIDE: Role = { kind: 'side', sideTicket: 'x-ab12', herdrPaneId: 'w1:p1' }
const SIDE_ENV = { TICKET_PANES_TICKET: 'x-ab12', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }
// What the engine says when a hook writes `$.state` while a `ui.render` hook draws.
const DRAW_DENIAL =
  'ticket-panes: state.set: denied: it was made while ui.render is being dispatched, and drawing is pure (a render hook reads state and returns a tree; write from a handler such as onPress, or from another event) (host check)'

// ---------- through the engine: what session.start does ----------

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

// Stands in for the engine beneath the plugin: answers session.start, gives the plugin `env`
// (or refuses every variable when it is null) and, when given, `stored` as the role `$.state`
// kept, and records the roles the plugin stores and the debug lines it logs.
function engine(on: On, env: Record<string, string> | null, stored?: Role) {
  if (env === null) on('env.get', () => ({ deny: 'the environment cannot be read here' }))
  else mock.env(on, env)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  if (stored !== undefined) on('state.get', roleRef, () => ({ value: { value: stored, version: 3 } }))
  const seen = { stored: [] as unknown[], logs: [] as string[] }
  on('state.set', roleRef, ($, e, next) => {
    seen.stored.push(e.value)
    return next(e)
  })
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  return seen
}

test('a new side session in herdr stores its role at start and runs the ready steps once', async ($, on) => {
  const seen = engine(on, SIDE_ENV)
  expect(await $.session.start(START)).toEqual({ cwd: '/repo' })
  expect(seen.stored).toEqual([SIDE])
  expect(seen.logs).toEqual([`ticket-panes: role ${JSON.stringify(SIDE)}`])
  // Started again in the same load: the role is known, so nothing is stored or run again.
  await $.session.start(START)
  expect(seen.stored).toHaveLength(1)
  expect(seen.logs).toHaveLength(1)
})

test('a main session stores main, with its pane only when in herdr', async ($, on) => {
  const seen = engine(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })
  await $.session.start(START)
  expect(seen.stored).toEqual([{ kind: 'main', herdrPaneId: 'w1:p1' }])
})

test('a session with none of the variables stores plain main', async ($, on) => {
  const seen = engine(on, {})
  await $.session.start(START)
  expect(seen.stored).toEqual([{ kind: 'main' }])
})

test('a role already stored is not written again', async ($, on) => {
  const same = engine(on, SIDE_ENV, SIDE)
  await $.session.start(START)
  expect(same.stored).toEqual([])
  expect(same.logs).toEqual([`ticket-panes: role ${JSON.stringify(SIDE)}`])
})

test('a stored role from another ticket is replaced by the one the environment gives', async ($, on) => {
  const seen = engine(on, SIDE_ENV, { kind: 'side', sideTicket: 'x-cd34', herdrPaneId: 'w1:p1' })
  await $.session.start(START)
  expect(seen.stored).toEqual([SIDE])
})

test('when the environment cannot be read, the role is the one $.state kept', async ($, on) => {
  const seen = engine(on, null, { kind: 'side', sideTicket: 'x-cd34' })
  await $.session.start(START)
  expect(seen.stored).toEqual([])
  expect(seen.logs).toEqual(['ticket-panes: role {"kind":"side","sideTicket":"x-cd34"}'])
})

// ---------- a stand-in for `$` ----------
// The rule modules' functions are called by no hook of this task yet. A test cannot reach them
// through the engine: its own `$` has no env, fs, store, state or clock, its hooks may only answer
// (the engine refuses a call on `$` they make), and this file runs its own copy of the modules.
// So they run against this stand-in, which has just the nouns they use and records what it was
// asked. Module variables carry over from test to test here, so tests use paths of their own
// and call `forgetRole()` before using `role`.

type Entry = { kind: 'file' | 'dir'; realPath?: string; isRealPathWithheld?: boolean }
type World = {
  env?: Record<string, string>
  isEnvRefused?: boolean
  root?: string
  files?: Record<string, Entry>
  stored?: Role | null
  isStateGetRefused?: boolean
  stateSetDenial?: string
  isLogRefused?: boolean
}

function fake(world: World = {}) {
  const seen = { env: [] as string[], stats: [] as string[], sets: [] as unknown[], toasts: [] as string[], logs: [] as string[] }
  const clock = { now: 0 }
  const store = new Map<string, unknown>()
  let stored = world.stored
  const $ = {
    env: {
      get: async (name: string) => {
        seen.env.push(name)
        if (world.isEnvRefused) throw new Error('env.get: refused')
        return world.env?.[name]
      },
    },
    session: { root: async () => world.root ?? '/' },
    fs: {
      stat: async (path: string, options?: { resolve: boolean }): Promise<FsStat> => {
        seen.stats.push(path)
        const entry = world.files?.[path]
        if (entry === undefined) throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
        const stat: FsStat = { kind: entry.kind, size: 0, mtimeMs: 0, isLink: entry.realPath !== undefined }
        if (options?.resolve && !entry.isRealPathWithheld) stat.realPath = entry.realPath ?? path
        return stat
      },
    },
    clock: { now: async () => clock.now },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
    },
    state: {
      get: async () => {
        if (world.isStateGetRefused) throw new Error('state.get: refused')
        return { value: stored, version: 0 }
      },
      set: async (ref: unknown, value: Role) => {
        if (world.stateSetDenial !== undefined) throw new Error(world.stateSetDenial)
        seen.sets.push(value)
        stored = value
        return { isSet: true, version: 1 }
      },
    },
    ui: {
      toast: (text: string) => {
        seen.toasts.push(text)
      },
      log: (text: string) => {
        if (world.isLogRefused) throw new Error('ui.log: refused')
        seen.logs.push(text)
      },
    },
  }
  return { $: $ as unknown as EngineInterface, seen, clock, store }
}

// ---------- R4 and R5: role.ts ----------

test('R4: the side ticket comes from TICKET_PANES_TICKET, the pane only when HERDR_ENV is 1', () => {
  expect(roleFrom('x-ab12', '1', 'w1:p1')).toStrictEqual(SIDE)
  expect(roleFrom('x-ab12', undefined, undefined)).toStrictEqual({ kind: 'side', sideTicket: 'x-ab12' })
  expect(roleFrom(undefined, '1', 'w1:p1')).toStrictEqual({ kind: 'main', herdrPaneId: 'w1:p1' })
  expect(roleFrom(undefined, undefined, undefined)).toStrictEqual({ kind: 'main' })
  // Not in herdr: HERDR_ENV other than 1, or no pane id.
  expect(roleFrom(undefined, 'true', 'w1:p1')).toStrictEqual({ kind: 'main' })
  expect(roleFrom('x-ab12', '1', '')).toStrictEqual({ kind: 'side', sideTicket: 'x-ab12' })
  // An empty ticket counts as unset, as tk treats its own variables.
  expect(roleFrom('', '1', 'w1:p1')).toStrictEqual({ kind: 'main', herdrPaneId: 'w1:p1' })
})

test('resolveRole stores the role only when it differs from the stored one', async () => {
  const fresh = fake({ env: SIDE_ENV })
  expect(await resolveRole(fresh.$)).toStrictEqual(SIDE)
  expect(fresh.seen.sets).toEqual([SIDE])
  const same = fake({ env: SIDE_ENV, stored: { ...SIDE } })
  expect(await resolveRole(same.$)).toStrictEqual(SIDE)
  expect(same.seen.sets).toEqual([])
  for (const old of [
    { kind: 'side', sideTicket: 'x-cd34', herdrPaneId: 'w1:p1' },
    { kind: 'side', sideTicket: 'x-ab12', herdrPaneId: 'w2:p1' },
    { kind: 'main', herdrPaneId: 'w1:p1' },
  ] as Role[]) {
    const changed = fake({ env: SIDE_ENV, stored: old })
    await resolveRole(changed.$)
    expect(changed.seen.sets, JSON.stringify(old)).toEqual([SIDE])
  }
})

test('resolveRole falls back to the stored role when the environment cannot be read', async () => {
  const kept = fake({ isEnvRefused: true, stored: SIDE })
  expect(await resolveRole(kept.$)).toStrictEqual(SIDE)
  expect(kept.seen.sets).toEqual([])
  expect(await resolveRole(fake({ isEnvRefused: true }).$)).toBeUndefined()
  expect(await resolveRole(fake({ isEnvRefused: true, stored: null }).$)).toBeUndefined()
  expect(await resolveRole(fake({ isEnvRefused: true, isStateGetRefused: true }).$)).toBeUndefined()
  // $.state unreadable but the environment fine: the environment's role, stored.
  const unreadable = fake({ env: SIDE_ENV, isStateGetRefused: true })
  expect(await resolveRole(unreadable.$)).toStrictEqual(SIDE)
  expect(unreadable.seen.sets).toEqual([SIDE])
})

test('resolveRole answers the role when $.state refuses the write, as it does inside a draw', async () => {
  const draw = fake({ env: SIDE_ENV, stateSetDenial: DRAW_DENIAL })
  expect(await resolveRole(draw.$)).toStrictEqual(SIDE)
})

test('AC R4: after a reload, the first draw resolves the side role without throwing and runs the ready steps once', async () => {
  forgetRole() // as a reload leaves the module: nothing resolved, and no session.start
  const draw = fake({ env: SIDE_ENV, stateSetDenial: DRAW_DENIAL })
  expect(knownRole()).toBeUndefined()
  expect(await role(draw.$)).toStrictEqual(SIDE)
  expect(draw.seen.logs).toEqual([`ticket-panes: role ${JSON.stringify(SIDE)}`])
  expect(knownRole()).toStrictEqual(SIDE)
  // The next draw: the role is known, so the environment is not read and nothing runs again.
  const reads = draw.seen.env.length
  expect(await role(draw.$)).toStrictEqual(SIDE)
  expect(draw.seen.env).toHaveLength(reads)
  expect(draw.seen.logs).toHaveLength(1)
})

test('role answers main and tries again later while neither the environment nor $.state can say', async () => {
  forgetRole()
  const blind = fake({ isEnvRefused: true })
  expect(await role(blind.$)).toStrictEqual({ kind: 'main' })
  expect(knownRole()).toBeUndefined()
  expect(blind.seen.logs).toEqual([])
  const later = fake({ env: SIDE_ENV })
  expect(await role(later.$)).toStrictEqual(SIDE)
  expect(later.seen.logs).toHaveLength(1)
})

test('calls made while the role resolves wait for that one resolution', async () => {
  forgetRole()
  const both = fake({ env: SIDE_ENV })
  expect(await Promise.all([role(both.$), role(both.$)])).toStrictEqual([SIDE, SIDE])
  expect(both.seen.env).toEqual(['TICKET_PANES_TICKET', 'HERDR_ENV', 'HERDR_PANE_ID'])
  expect(both.seen.logs).toHaveLength(1)
})

test('the role resolves even when the debug log refuses its line', async () => {
  forgetRole()
  const quiet = fake({ env: SIDE_ENV, isLogRefused: true })
  expect(await role(quiet.$)).toStrictEqual(SIDE)
  expect(knownRole()).toStrictEqual(SIDE)
  forgetRole()
})

test('AC R5: a prompt counts unless it runs a slash command or is one the person did not see typed', () => {
  expect(isCountedPrompt({})).toBe(true)
  expect(isCountedPrompt({ command: { name: 'model', args: '' } })).toBe(false)
  expect(isCountedPrompt({ isMeta: true })).toBe(false)
})

// ---------- R1: tickets.ts ----------

// A repo whose worktree's .tickets is a link to the repo's.
const LINKED: Record<string, Entry> = {
  '/repo/.tickets': { kind: 'dir' },
  '/repo/.worktrees/w1/.tickets': { kind: 'dir', realPath: '/repo/.tickets' },
  '/repo/.tickets/x-ab12.md': { kind: 'file' },
}

test('AC R1: from a worktree whose .tickets links to the repo, the tickets dir is the repo one, by its real path', async () => {
  const worktree = fake({ root: '/repo/.worktrees/w1', files: LINKED })
  expect(await ticketsDir(worktree.$)).toBe('/repo/.tickets')
  expect(await ticketsDir(fake({ root: '/repo', files: LINKED }).$)).toBe('/repo/.tickets')
  expect(await isTicket(worktree.$, 'x-ab12')).toBe(true)
  expect(worktree.seen.stats).toContain('/repo/.tickets/x-ab12.md')
})

test('the tickets dir is the nearest .tickets folder walking up, checked up to /', async () => {
  const deep = fake({ root: '/repo/src/deep/', files: LINKED })
  expect(await ticketsDir(deep.$)).toBe('/repo/.tickets')
  expect(deep.seen.stats).toEqual(['/repo/src/deep/.tickets', '/repo/src/.tickets', '/repo/.tickets'])
  const none = fake({ root: '/elsewhere/x', files: LINKED })
  expect(await ticketsDir(none.$)).toBeUndefined()
  expect(none.seen.stats).toEqual(['/elsewhere/x/.tickets', '/elsewhere/.tickets', '/.tickets'])
  expect(await ticketsDir(fake({ root: '/a', files: { '/.tickets': { kind: 'dir' } } }).$)).toBe('/.tickets')
  // A .tickets that is a file is not the folder; the walk goes on past it.
  const shadowed = { ...LINKED, '/repo/sub/.tickets': { kind: 'file' } } as Record<string, Entry>
  expect(await ticketsDir(fake({ root: '/repo/sub', files: shadowed }).$)).toBe('/repo/.tickets')
  // A folder whose real path a hook withheld is taken as spelled.
  const withheld = { '/repo/.worktrees/w1/.tickets': { kind: 'dir', realPath: '/repo/.tickets', isRealPathWithheld: true } } as Record<string, Entry>
  expect(await ticketsDir(fake({ root: '/repo/.worktrees/w1', files: withheld }).$)).toBe('/repo/.worktrees/w1/.tickets')
})

test('TICKETS_DIR, when set, is the tickets dir as given; empty counts as unset', async () => {
  const given = fake({ env: { TICKETS_DIR: '/data/tickets' }, root: '/repo', files: LINKED })
  expect(await ticketsDir(given.$)).toBe('/data/tickets')
  expect(given.seen.stats).toEqual([])
  expect(await ticketsDir(fake({ env: { TICKETS_DIR: '' }, root: '/repo', files: LINKED }).$)).toBe('/repo/.tickets')
})

test('AC R1: a ticket found stays found; a missing one is looked for again only after 60 seconds', async () => {
  const files: Record<string, Entry> = { '/r1/.tickets': { kind: 'dir' }, '/r1/.tickets/x-ab12.md': { kind: 'file' } }
  const r1 = fake({ root: '/r1', files })
  const looks = () => r1.seen.stats.filter(path => path.endsWith('.md'))
  r1.clock.now = 1_000_000
  expect(await isTicket(r1.$, 'x-ab12')).toBe(true)
  expect(await isTicket(r1.$, 'x-ab12')).toBe(true)
  expect(looks()).toEqual(['/r1/.tickets/x-ab12.md'])
  expect(await isTicket(r1.$, 'x-cd34')).toBe(false)
  // The file appears; until 60 seconds have passed the miss stands without another look.
  files['/r1/.tickets/x-cd34.md'] = { kind: 'file' }
  r1.clock.now += 59_999
  expect(await isTicket(r1.$, 'x-cd34')).toBe(false)
  expect(looks()).toEqual(['/r1/.tickets/x-ab12.md', '/r1/.tickets/x-cd34.md'])
  r1.clock.now += 1
  expect(await isTicket(r1.$, 'x-cd34')).toBe(true)
  expect(looks()).toHaveLength(3)
  // A ticket that is gone stays found for the load.
  delete files['/r1/.tickets/x-ab12.md']
  expect(await isTicket(r1.$, 'x-ab12')).toBe(true)
})

test('no tickets dir, or a folder named like a ticket file, is no ticket', async () => {
  expect(await isTicket(fake({ root: '/nowhere' }).$, 'x-ab12')).toBe(false)
  const odd = fake({ root: '/r2', files: { '/r2/.tickets': { kind: 'dir' }, '/r2/.tickets/x-ab12.md': { kind: 'dir' } } })
  expect(await isTicket(odd.$, 'x-ab12')).toBe(false)
})

// ---------- R3: sessions.ts ----------

test('AC R3: the session recorded last for a dir and ticket is the one returned; another dir has none', async () => {
  const s = fake()
  await recordSession(s.$, '/repo/.tickets', 'x-ab12', { sessionId: 'S1', cwd: '/repo' })
  await recordSession(s.$, '/repo/.tickets', 'x-ab12', { sessionId: 'S2', cwd: '/repo/.worktrees/w1' })
  expect(await recordedSession(s.$, '/repo/.tickets', 'x-ab12')).toEqual({ sessionId: 'S2', cwd: '/repo/.worktrees/w1' })
  expect(await recordedSession(s.$, '/other/.tickets', 'x-ab12')).toBeUndefined()
  expect(await recordedSession(s.$, '/repo/.tickets', 'x-cd34')).toBeUndefined()
  expect([...s.store.keys()]).toEqual(['session:/repo/.tickets:x-ab12'])
})

test('a stored value that is not a session reads as none', async () => {
  const s = fake()
  for (const junk of ['S1', null, 7, { sessionId: 'S1' }, { cwd: '/repo' }, { sessionId: 7, cwd: '/repo' }, { sessionId: 'S1', cwd: 7 }]) {
    s.store.set('session:/repo/.tickets:x-ab12', junk)
    expect(await recordedSession(s.$, '/repo/.tickets', 'x-ab12'), JSON.stringify(junk)).toBeUndefined()
  }
})

// ---------- notify.ts ----------

test('AC: the notices of one open show as one toast when it ends; any other shows at once', () => {
  const n = fake()
  notify(n.$, 'outside')
  expect(n.seen.toasts).toEqual(['outside'])
  beginNotices()
  notify(n.$, 'a')
  notify(n.$, 'b')
  expect(n.seen.toasts).toEqual(['outside'])
  flushNotices(n.$)
  expect(n.seen.toasts).toEqual(['outside', 'a; b'])
  // After the open, at once again; an open with nothing to say shows nothing.
  notify(n.$, 'after')
  beginNotices()
  flushNotices(n.$)
  flushNotices(n.$)
  expect(n.seen.toasts).toEqual(['outside', 'a; b', 'after'])
})
