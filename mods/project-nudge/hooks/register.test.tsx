import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { RUN_ENV, changedFiles, parse, parseTrust } from './register'

const ROOT = '/repo'
const HOME = '/home/u'
const LIST = `${HOME}/.claude/project-nudge.json`
const RUN = `${ROOT}/.claude/nudge/run`
const TRUST = `${ROOT}/.claude/nudge/trust`

const NULL_OUT = '{"version": 1, "nudge": null}'
const NUDGE_OUT = JSON.stringify({
  version: 1,
  nudge: { title: 'Next', lines: ['Write the summary', 'then review it'], command: '/summarize 3' },
  context: 'Tell the user the summary is due.',
})

type World = {
  files: Map<string, string>
  links: Set<string>
  notExecutable: boolean
  stdout: string
  runs: Record<string, string>[]
  toasts: string[]
  fills: string[]
  writes: string[]
  /** The session's environment variables. */
  env: Record<string, string>
  /** While true, each run of the script waits until the test calls finishOne. */
  slow: boolean
  /** Runs of the script that have finished. */
  finished: number
  held: (() => void)[]
  /** Lets the work the mod runs in the background finish. */
  settle: () => Promise<void>
  /** Lets the oldest held run of the script finish, then settles. */
  finishOne: () => Promise<void>
}

// The fake git's blob hash: one line per file, whatever the content holds.
function hash(content: string | undefined): string {
  return `h:${JSON.stringify(content ?? null)}`
}

// Stands in for the engine: a small file system under /repo and $HOME, git
// hashing a file's content as `h:<content>`, and the nudge script printing
// `stdout`. Every run of the script records the environment it was given.
function engine(on: On, files: Record<string, string>): World {
  const w: World = {
    files: new Map(Object.entries(files)),
    links: new Set(),
    notExecutable: false,
    stdout: NULL_OUT,
    runs: [],
    toasts: [],
    fills: [],
    writes: [],
    env: { HOME },
    slow: false,
    finished: 0,
    held: [],
    settle: () => clock.settle(),
    finishOne: async () => {
      w.held.shift()?.()
      await clock.settle()
    },
  }
  const clock = mock.clock(on)
  const isDir = (p: string) => [...w.files.keys()].some(f => f.startsWith(`${p}/`))
  const ok = (stdout = '', exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('session.cwd', () => ({ value: `${ROOT}/sub` }))
  on('env.get', ($, e) => ({ value: w.env[e.name] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) || isDir(e.path) }))
  on('fs.stat', ($, e) => {
    if (!w.files.has(e.path) && !isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const kind = isDir(e.path) ? 'dir' : 'file'
    return { value: { kind, size: 0, mtimeMs: 0, isLink: w.links.has(e.path) } }
  })
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.writes.push(e.path)
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    const [cmd, ...args] = e.argv
    const cwd = e.init?.cwd
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok(`${ROOT}\n`)
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('c0ffee\n')
    if (cmd === 'git' && args[0] === 'hash-object') {
      return ok(`${args.slice(2).map(p => hash(w.files.get(`${cwd}/${p}`))).join('\n')}\n`)
    }
    if (cmd === 'test') return ok('', w.notExecutable ? 1 : 0)
    if (cmd === 'mktemp') return ok(`${LIST}.tmp1\n`)
    if (cmd === 'mv') {
      w.files.set(args[2] ?? '', w.files.get(args[1] ?? '') ?? '')
      w.files.delete(args[1] ?? '')
      return ok()
    }
    if (cmd === RUN) {
      w.runs.push({ ...e.init?.env })
      if (w.slow) await new Promise<void>(resolve => w.held.push(resolve))
      w.finished += 1
      return ok(w.stdout)
    }
    throw new Error(`unexpected command: ${e.argv.join(' ')}`)
  })
  return w
}

const NUDGE_FILES = {
  [RUN]: '#!/bin/sh\nexec python3 scripts/status.py\n',
  [TRUST]: '# what run executes\nscripts/status.py\n',
  [`${ROOT}/scripts/status.py`]: 'print("{}")',
}

function allowed(files: Record<string, string>) {
  const hashes = {
    '.claude/nudge/run': hash(files[RUN]),
    '.claude/nudge/trust': hash(files[TRUST]),
    'scripts/status.py': hash(files[`${ROOT}/scripts/status.py`]),
  }
  return JSON.stringify({ version: 1, repos: { [ROOT]: { answer: 'allow', files: hashes, commit: 'c0ffee' } } })
}

const BAND = {
  plugin: 'project-nudge',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const START = { cwd: `${ROOT}/sub`, surface: 'terminal', isInteractive: true } as const
const MAIN_TURN = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

// ---- the contract ----------------------------------------------------------

test('the contract: null is nothing to do, and a nudge keeps its lines, command and context', () => {
  expect(parse(ROOT, NULL_OUT).view).toEqual({ kind: 'none' })
  const out = parse(ROOT, NUDGE_OUT)
  expect(out.view).toEqual({ kind: 'nudge', root: ROOT, title: 'Next', lines: ['Write the summary', 'then review it'], command: '/summarize 3' })
  expect(out.context).toBe('Tell the user the summary is due.')
  const bare = parse(ROOT, '{"version": 1, "nudge": {"title": "T", "lines": ["x"]}}')
  expect(bare.view).toEqual({ kind: 'nudge', root: ROOT, title: 'T', lines: ['x'], command: null })
})

test('the contract: every broken shape is an error that offers setup', () => {
  const broken = [
    '',
    '  \n',
    'not json',
    '[1]',
    '{"version": 2, "nudge": null}',
    '{"version": 1}',
    '{"version": 1, "nudge": "x"}',
    '{"version": 1, "nudge": {"title": "", "lines": ["x"]}}',
    '{"version": 1, "nudge": {"title": "T", "lines": []}}',
    '{"version": 1, "nudge": {"title": "T", "lines": [""]}}',
    '{"version": 1, "nudge": {"title": "T", "lines": [1]}}',
    '{"version": 1, "nudge": {"title": "T", "lines": ["x"], "command": 3}}',
    '{"version": 1, "nudge": null, "context": 5}',
  ]
  for (const stdout of broken) {
    const v = parse(ROOT, stdout).view
    expect(v.kind).toBe('error')
    expect(v.kind === 'error' && v.setup).toBe(true)
  }
})

test('trust skips blank and comment lines, and keeps a # inside a path', () => {
  expect(parseTrust('# header\n\n  scripts/a.py  \nnotes/#1.md\n  # indented comment\n')).toEqual(['scripts/a.py', 'notes/#1.md'])
})

test('changed files include ones added to or dropped from the pin', () => {
  expect(changedFiles({ a: '1', b: '2', c: '3' }, { a: '1', b: 'x', d: '4' })).toEqual(['b', 'c', 'd'])
})

// ---- asking, allowing and pinning ------------------------------------------


test('a repo without .claude/nudge shows nothing and runs nothing', async ($, on) => {
  const w = engine(on, {})
  await $.session.start(START)
  await w.settle()
  await $.turn.complete(MAIN_TURN)
  await w.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /NUDGE/ })).toBeUndefined()
  expect(w.runs).toEqual([])
  await ui.unmount()
})

test('a new repo is asked about first; Allow pins the files, then the script runs with the safe environment', async ($, on) => {
  const w = engine(on, NUDGE_FILES)
  w.stdout = NUDGE_OUT
  await $.session.start(START)
  await w.settle()
  expect(w.runs).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /has a nudge script/ }))?.text).toContain('scripts/status.py')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'allow' })
  await w.settle()
  const list = JSON.parse(w.files.get(LIST) ?? '{}')
  expect(list.repos[ROOT].files['scripts/status.py']).toBe(hash('print("{}")'))
  expect(list.repos[ROOT].commit).toBe('c0ffee')
  expect(w.writes).toEqual([`${LIST}.tmp1`]) // written beside it, then renamed over it
  expect(w.files.has(`${LIST}.tmp1`)).toBe(false)
  expect(w.runs).toEqual([RUN_ENV])
  expect((await ui.find({ type: 'Text', text: /Write the summary/ }))?.text).toBe('Write the summary')
  await ui.unmount()
})

test('Allow refuses when a file changed after the band appeared, and asks about what is there now', async ($, on) => {
  const w = engine(on, NUDGE_FILES)
  await $.session.start(START)
  await w.settle()
  w.files.set(`${ROOT}/scripts/status.py`, 'import os; os.system("curl evil")')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'allow' })
  await w.settle()
  expect(w.files.has(LIST)).toBe(false)
  expect(w.runs).toEqual([])
  expect(w.toasts).toEqual(['nudge: the files changed after this band appeared; look again before allowing'])
  expect(await ui.find({ type: 'Text', text: /has a nudge script/ })).toBeDefined()
  await ui.unmount()
})

test('a pinned file that changes stops the script until approved again', async ($, on) => {
  const w = engine(on, { ...NUDGE_FILES, [LIST]: allowed(NUDGE_FILES) })
  await $.session.start(START)
  await w.settle()
  expect(w.runs.length).toBe(1)
  w.files.set(`${ROOT}/scripts/status.py`, 'print("changed")')
  await $.turn.complete(MAIN_TURN)
  await w.settle()
  expect(w.runs.length).toBe(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /changed since you allowed it/ }))?.text).toContain('scripts/status.py')
  await ui.press({ key: 'allow' })
  await w.settle()
  expect(w.runs.length).toBe(2)
  await ui.unmount()
})

test('Never is remembered and the repo stays quiet', async ($, on) => {
  const w = engine(on, NUDGE_FILES)
  await $.session.start(START)
  await w.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'never' })
  await w.settle()
  expect(JSON.parse(w.files.get(LIST) ?? '{}').repos[ROOT]).toBe('never')
  expect(await ui.find({ type: 'Text', text: /NUDGE/ })).toBeUndefined()
  await $.turn.complete(MAIN_TURN)
  await w.settle()
  expect(w.runs).toEqual([])
  await ui.unmount()
})

// ---- unusable trust files --------------------------------------------------

const UNUSABLE: [string, string, (w: World) => void, RegExp][] = [
  ['a symbolic link', 'scripts/status.py', w => w.links.add(`${ROOT}/scripts/status.py`), /symbolic link/],
  ['a folder', 'scripts', () => {}, /not a file/],
  ['a path out of the repo', '../elsewhere.py', () => {}, /inside the repo/],
  ['an absolute path', '/etc/passwd', () => {}, /inside the repo/],
  ['a missing file', 'scripts/missing.py', () => {}, /does not exist/],
]

for (const [name, entry, arrange, message] of UNUSABLE) {
  test(`trust listing ${name} is a contract error and nothing runs`, async ($, on) => {
    const w = engine(on, { ...NUDGE_FILES, [TRUST]: `${entry}\n` })
    arrange(w)
    await $.session.start(START)
    await w.settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: message }))?.text).toMatch(message)
    expect(await ui.find({ type: 'Button', key: 'setup' })).toBeDefined()
    expect(w.runs).toEqual([])
    await ui.unmount()
  })
}

test('a run script that is not executable is a contract error', async ($, on) => {
  const w = engine(on, NUDGE_FILES)
  w.notExecutable = true
  await $.session.start(START)
  await w.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /not executable/ })).toBeDefined()
  await ui.unmount()
})

test('a missing trust file is a contract error', async ($, on) => {
  const { [TRUST]: _, ...noTrust } = NUDGE_FILES
  const w = engine(on, noTrust)
  await $.session.start(START)
  await w.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /no trust file/ })).toBeDefined()
  await ui.unmount()
})

// ---- when it runs ----------------------------------------------------------

test('a launch runs the script once and hands its context to Claude', async ($, on) => {
  const w = engine(on, { ...NUDGE_FILES, [LIST]: allowed(NUDGE_FILES) })
  w.stdout = NUDGE_OUT
  await $.session.start(START)
  await w.settle()
  const result = await $.classic.SessionStart({ source: 'startup' })
  await w.settle()
  expect(w.runs.length).toBe(1)
  expect(result.additionalContext).toEqual(['Tell the user the summary is due.'])
})

test('a /clear after a turn runs the script again', async ($, on) => {
  const w = engine(on, { ...NUDGE_FILES, [LIST]: allowed(NUDGE_FILES) })
  await $.session.start(START)
  await w.settle()
  await $.classic.SessionStart({ source: 'startup' })
  await w.settle()
  await $.turn.complete(MAIN_TURN)
  await w.settle()
  await $.classic.SessionStart({ source: 'clear' })
  await w.settle()
  expect(w.runs.length).toBe(3)
})

test("a subagent's turn does not run the script; a main-loop turn does", async ($, on) => {
  const w = engine(on, { ...NUDGE_FILES, [LIST]: allowed(NUDGE_FILES) })
  await $.session.start(START)
  await w.settle()
  await $.turn.complete({ ...MAIN_TURN, agentId: 'a1' })
  await w.settle()
  expect(w.runs.length).toBe(1)
  await $.turn.complete(MAIN_TURN)
  await w.settle()
  expect(w.runs.length).toBe(2)
})

for (const [answer, files] of [
  ['not asked yet', NUDGE_FILES],
  ['allowed', { ...NUDGE_FILES, [LIST]: allowed(NUDGE_FILES) }],
] as const) {
  test(`a side session another tool opened, in a repo ${answer}, shows no band, gets no context and runs nothing`, async ($, on) => {
    const w = engine(on, files)
    w.stdout = NUDGE_OUT
    w.env.CLAUDE_SIDE_SESSION = 'ticket-panes'
    await $.session.start(START)
    const result = await $.classic.SessionStart({ source: 'startup' })
    await $.turn.complete(MAIN_TURN)
    await w.settle()
    expect(result.additionalContext ?? []).toEqual([])
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /NUDGE|Write the summary/ })).toBeUndefined()
    expect(w.runs).toEqual([])
    await ui.unmount()
  })
}

test('a turn ends without waiting for a slow script', async ($, on) => {
  const w = engine(on, { ...NUDGE_FILES, [LIST]: allowed(NUDGE_FILES) })
  await $.session.start(START)
  await w.settle()
  w.slow = true
  await $.turn.complete(MAIN_TURN)
  await w.settle()
  expect(w.runs.length).toBe(2)
  expect(w.finished).toBe(1) // the turn is done; its run is still going
  await w.finishOne()
  expect(w.finished).toBe(2)
})

test('turns that end while the script runs share one more run', async ($, on) => {
  const w = engine(on, { ...NUDGE_FILES, [LIST]: allowed(NUDGE_FILES) })
  await $.session.start(START)
  await w.settle()
  w.slow = true
  await $.turn.complete(MAIN_TURN)
  await $.turn.complete(MAIN_TURN)
  await $.turn.complete(MAIN_TURN)
  await w.settle()
  expect(w.runs.length).toBe(2)
  await w.finishOne()
  expect(w.runs.length).toBe(3)
  await w.finishOne()
  expect(w.finished).toBe(3)
  await $.turn.complete(MAIN_TURN)
  await w.settle()
  expect(w.runs.length).toBe(4)
  await w.finishOne()
})

test('the Load button fills the prompt with the command and hides the band until it changes', async ($, on) => {
  const w = engine(on, { ...NUDGE_FILES, [LIST]: allowed(NUDGE_FILES) })
  w.stdout = NUDGE_OUT
  await $.session.start(START)
  await w.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'go' })
  await w.settle()
  expect(w.fills).toEqual(['/summarize 3'])
  await $.turn.complete(MAIN_TURN)
  await w.settle()
  expect(await ui.find({ type: 'Text', text: /Write the summary/ })).toBeUndefined()
  w.stdout = JSON.stringify({ version: 1, nudge: { title: 'Next', lines: ['Review the summary'] } })
  await $.turn.complete(MAIN_TURN)
  await w.settle()
  expect(await ui.find({ type: 'Text', text: /Review the summary/ })).toBeDefined()
  await ui.unmount()
})

test('a failing script shows its stderr, and its fix button names the bundled skill', async ($, on) => {
  const w = engine(on, { ...NUDGE_FILES, [LIST]: allowed(NUDGE_FILES) })
  w.stdout = 'oops'
  await $.session.start(START)
  await w.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'setup' })
  await w.settle()
  expect(w.fills[0]).toStartWith('/project-nudge:nudge-setup run printed something that is not JSON')
  expect(w.toasts.length).toBe(1)
  await ui.unmount()
})
