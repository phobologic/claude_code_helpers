import type { EngineInterface, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { commandsIn, deniedGitOf, isSideOnFailure, onGuardFailure, placeOf, tkUseOf } from './guard'
import { forgetRole, role, roleRef } from './role'
import type { Role } from './role'

// guard.ts. The Bash reader (commandsIn, deniedGitOf, tkUseOf) is pure and is checked directly,
// a row per rule so that dropping any one entry fails. The hook runs through the engine: the
// plugin loads fresh for each test with no session.start, as after a reload, and the test's hooks
// stand in for the world beneath it (the environment, the session root, the file system, the run
// lookup, `tk backlog`, and the tools themselves). No real tk or run-tickets-status runs (K3).

const ROOT = '/repo'
const SIDE_ENV = { TICKET_PANES_TICKET: 'x-ab12', TICKETS_DIR: '/repo/.tickets' }
const MAIN_ENV = { TICKETS_DIR: '/repo/.tickets', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }
// The backlog epic, and the epic of the run that holds the side ticket.
const BACKLOG = 'x-cd34'
const RUN_EPIC = 'x-ef56'
const FAILED = { deny: 'ticket side agent guard failed' }
const LOOKUP = ['run-tickets-status', '--find-ticket', 'x-ab12']

type Exit = { code: number; stdout?: string; stderr?: string }

type World = {
  // The paths that exist, each with where it lands (`null`: it exists but leads nowhere, as a
  // dangling link does). Any other path is missing.
  paths: Record<string, string | null>
  // How the run lookup (R2) exits: a running run holds the ticket, none does, or it can't tell.
  lookup: Exit
  // How `tk backlog` exits; undefined refuses the call.
  backlog: Exit | undefined
  // The session root, and whether reading it is refused.
  root: string
  isRootRefused: boolean
  // Every process the plugin ran, with its options.
  runs: { argv: string[]; cwd?: string; timeoutMs?: number }[]
  // Every tool call that got past the guard, as `<tool> <path or command>`.
  ran: string[]
}

const IN_RUN: Exit = { code: 0, stdout: '{"run_id": "wf_1", "state": "running"}\n' }
const NOT_IN_RUN: Exit = { code: 1 }
const LOOKUP_FAILS: Exit = { code: 2, stderr: 'run-tickets-status: not inside a git repository\n' }

function world(on: On, env: Record<string, string>, init: Partial<World> = {}): World {
  const w: World = {
    paths: { '/': '/', [ROOT]: ROOT },
    lookup: IN_RUN,
    backlog: { code: 0, stdout: `${BACKLOG}\n` },
    root: ROOT,
    isRootRefused: false,
    runs: [],
    ran: [],
    ...init,
  }
  mock.env(on, env)
  mock.clock(on, { now: 1_000_000 })
  on('session.root', () => (w.isRootRefused ? { deny: 'no session root here' } : { value: w.root }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('fs.stat', ($, e) => {
    const real = w.paths[e.path]
    if (real === undefined) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
    const stat = { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: real !== e.path }
    return { value: e.resolve && real !== null ? { ...stat, realPath: real } : stat }
  })
  on('process.run', ($, e) => {
    w.runs.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    const exit = e.argv[0] === 'tk' ? w.backlog : w.lookup
    if (exit === undefined) return { deny: 'tk is not here' }
    return { value: { exitCode: exit.code, stdout: exit.stdout ?? '', stderr: exit.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    w.ran.push(`Bash ${e.command}`)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'Write' }, ($, e) => {
    w.ran.push(`Write ${e.file_path}`)
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  on('tool.call', { tool: 'Edit' }, ($, e) => {
    w.ran.push(`Edit ${e.file_path}`)
    const result = { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: '', structuredPatch: [], userModified: false, replaceAll: false }
    return { result }
  })
  on('tool.call', { tool: 'NotebookEdit' }, ($, e) => {
    w.ran.push(`NotebookEdit ${e.notebook_path}`)
    const result = { new_source: e.new_source, cell_type: 'code' as const, language: 'python', edit_mode: 'replace', notebook_path: e.notebook_path, original_file: '', updated_file: '' }
    return { result }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  return w
}

function bash($: Engine, command: string) {
  return $.tool.call({ tool: 'Bash', command })
}

function write($: Engine, path: string) {
  return $.tool.call({ tool: 'Write', file_path: path, content: 'x' })
}

function edit($: Engine, path: string) {
  return $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })
}

function notebook($: Engine, path: string) {
  return $.tool.call({ tool: 'NotebookEdit', notebook_path: path, new_source: 'x' })
}

function denial(result: unknown): string | undefined {
  return (result as { deny?: string }).deny
}

// The deny each of `commands` meets, run one at a time (undefined for one that ran).
async function denials($: Engine, commands: readonly string[]): Promise<[string, string | undefined][]> {
  const answers: [string, string | undefined][] = []
  for (const command of commands) answers.push([command, denial(await bash($, command))])
  return answers
}

// ---------- reading Bash text (E16) ----------

test('commandsIn splits on newlines, ;, &&, ||, |, |& and a lone &', () => {
  const texts = ['a 1\nb 2', 'a 1;b 2', 'a 1 && b 2', 'a 1||b 2', 'a 1 | b 2', 'a 1 |& b 2', 'a 1 & b 2', 'a 1 &\nb 2']
  expect(texts.map(text => [text, commandsIn(text)])).toStrictEqual(texts.map(text => [text, [['a', '1'], ['b', '2']]]))
})

test('commandsIn keeps the & of a redirection in its word', () => {
  expect(commandsIn('tk close x 2>&1')).toStrictEqual([['tk', 'close', 'x', '2>&1']])
  expect(commandsIn('tk close x <&3')).toStrictEqual([['tk', 'close', 'x', '<&3']])
  expect(commandsIn('tk close x &>/dev/null')).toStrictEqual([['tk', 'close', 'x', '&>/dev/null']])
  // `&&` after `>` is still the operator, and a `|` always ends the command.
  expect(commandsIn('a >&& b')).toStrictEqual([['a', '>'], ['b']])
  expect(commandsIn('a |>f')).toStrictEqual([['a'], ['>f']])
})

test('commandsIn removes quotes and backslashes, and never splits inside quotes', () => {
  expect(commandsIn('tk add-note x "a; tk close y" \'b && c\'')).toStrictEqual([['tk', 'add-note', 'x', 'a; tk close y', 'b && c']])
  expect(commandsIn('tk add-note x "say \\"hi\\" for \\$5 \\\\ \\n"')).toStrictEqual([['tk', 'add-note', 'x', 'say "hi" for $5 \\ \\n']])
  expect(commandsIn('a "line\\\nend"')).toStrictEqual([['a', 'lineend']])
  expect(commandsIn('a "\\`b"')).toStrictEqual([['a', '`b']])
  // A $ that opens no group is a character of its word.
  expect(commandsIn('echo $HOME "$USER" x$')).toStrictEqual([['echo', '$HOME', '$USER', 'x$']])
  expect(commandsIn('a x\\;y\\ z')).toStrictEqual([['a', 'x;y z']])
  // A backslash and newline join the lines; a quoted empty word is still a word.
  expect(commandsIn('tk \\\nclose x')).toStrictEqual([['tk', 'close', 'x']])
  expect(commandsIn('a "" b')).toStrictEqual([['a', '', 'b']])
  expect(commandsIn('a\tb')).toStrictEqual([['a', 'b']])
})

test('commandsIn lists the commands of every $(...) and backtick group, unquoted or in double quotes', () => {
  expect(commandsIn('echo $(tk close y)')).toStrictEqual([['tk', 'close', 'y'], ['echo', '$(tk close y)']])
  expect(commandsIn('echo "x $(tk close y) z"')).toStrictEqual([['tk', 'close', 'y'], ['echo', 'x $(tk close y) z']])
  expect(commandsIn('echo `tk close y`')).toStrictEqual([['tk', 'close', 'y'], ['echo', '`tk close y`']])
  expect(commandsIn('echo "`tk close y`"')).toStrictEqual([['tk', 'close', 'y'], ['echo', '`tk close y`']])
  expect(commandsIn('ID=$(tk create "t" --parent x-ef56)')).toStrictEqual([['tk', 'create', 't', '--parent', 'x-ef56'], ['ID=$(tk create "t" --parent x-ef56)']])
  // Nested, and a group holding a `)` in quotes or a group of its own.
  expect(commandsIn('a $(b $(tk close y))')).toStrictEqual([['tk', 'close', 'y'], ['b', '$(tk close y)'], ['a', '$(b $(tk close y))']])
  expect(commandsIn('a $(b ")" (c) d)')).toStrictEqual([['b', ')'], ['c'], ['d'], ['a', '$(b ")" (c) d)']])
  // Inside backticks, \` \\ and \$ are unescaped before the group is read; any other backslash
  // stays, so a backslash and newline still join the lines.
  expect(commandsIn('a `b \\`tk close y\\``')).toStrictEqual([['tk', 'close', 'y'], ['b', '`tk close y`'], ['a', '`b \\`tk close y\\``']])
  expect(commandsIn('a `echo \\$(c)y`')).toStrictEqual([['c'], ['echo', '$(c)y'], ['a', '`echo \\$(c)y`']])
  expect(commandsIn('a `b \\\\q`')).toStrictEqual([['b', 'q'], ['a', '`b \\\\q`']])
  expect(commandsIn('a `b \\\nc`')).toStrictEqual([['b', 'c'], ['a', '`b \\\nc`']])
})

test('commandsIn reads single-quoted text as text', () => {
  expect(commandsIn("echo '$(tk close y)' '`tk close y`'")).toStrictEqual([['echo', '$(tk close y)', '`tk close y`']])
})

test('commandsIn ends a command at a group\'s parentheses, and at a ) with no group open', () => {
  expect(commandsIn('(tk close y)')).toStrictEqual([['tk', 'close', 'y']])
  expect(commandsIn('a (b) c')).toStrictEqual([['a'], ['b'], ['c']])
  expect(commandsIn('a ) b')).toStrictEqual([['a'], ['b']])
  expect(commandsIn('echo $((1 + 2)) x')).toStrictEqual([['1', '+', '2'], ['echo', '$((1 + 2))', 'x']])
})

test('commandsIn reads a # that starts a word as a comment to the end of its line', () => {
  expect(commandsIn("ls # it's fine\ntk close y")).toStrictEqual([['ls'], ['tk', 'close', 'y']])
  expect(commandsIn('ls # last')).toStrictEqual([['ls']])
  expect(commandsIn('echo a#b')).toStrictEqual([['echo', 'a#b']])
})

test('commandsIn answers undefined for text it cannot split', () => {
  const texts = ['echo "a', "echo 'a", 'echo $(a', 'echo `a', 'echo "$(a"', 'echo "$(a)', 'echo "`a"', 'echo "`a`', 'a `b "`', 'a $(b "c)', 'a `b $(c`', 'a "\\']
  expect(texts.map(text => [text, commandsIn(text)])).toStrictEqual(texts.map(text => [text, undefined]))
})

test('deniedGitOf names each commit-making subcommand', () => {
  const subs = ['commit', 'push', 'merge', 'revert', 'cherry-pick', 'am', 'rebase', 'pull']
  expect(subs.map(sub => deniedGitOf(['git', sub, 'x']))).toStrictEqual(subs)
  for (const sub of ['status', 'log', 'diff', 'add', 'show', 'branch']) expect(deniedGitOf(['git', sub])).toBeUndefined()
  expect(deniedGitOf(['git'])).toBeUndefined()
})

test('deniedGitOf finds git by its basename, after assignments, env and a group\'s opening', () => {
  const lines = [['/usr/bin/git', 'commit'], ['env', 'A=1', 'git', 'commit'], ['/usr/bin/env', 'git', 'commit'], ['A=1', 'B=2', 'git', 'commit'], ['{', 'git', 'commit'], ['!', 'git', 'commit'], ['({!git', 'commit']]
  expect(lines.map(words => deniedGitOf(words))).toStrictEqual(lines.map(() => 'commit'))
  for (const words of [['echo', 'git', 'commit'], ['gitx', 'commit'], ['legit', 'commit']]) expect(deniedGitOf(words)).toBeUndefined()
})

test('deniedGitOf passes over global options, and those that take a value take the next word', () => {
  for (const options of [['-C', '.'], ['-c', 'k=v'], ['--git-dir=x'], ['--work-tree=x'], ['--no-pager'], ['-p'], ['--git-dir', 'x', '--work-tree', 'y']])
    expect([options, deniedGitOf(['git', ...options, 'commit'])]).toStrictEqual([options, 'commit'])
  // Each option that takes a value takes the word after it, here `commit`, so status is the subcommand.
  const valued = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']
  expect(valued.map(option => [option, deniedGitOf(['git', option, 'commit', 'status'])])).toStrictEqual(valued.map(option => [option, undefined]))
})

test('tkUseOf lets each allow-listed subcommand through, as itself or under super', () => {
  const allowed = ['show', 'ls', 'list', 'query', 'ready', 'blocked', 'closed', 'help', '--help', '-h', 'add-note', 'backlog', 'show-multi', 'epic-status', 'epic-tree', 'triage']
  expect(allowed.map(sub => [sub, tkUseOf(['tk', sub, 'x'])])).toStrictEqual(allowed.map(sub => [sub, undefined]))
  expect(allowed.map(sub => [sub, tkUseOf(['tk', 'super', sub])])).toStrictEqual(allowed.map(sub => [sub, undefined]))
  // A bare tk, and a bare tk super, run tk's help.
  expect(tkUseOf(['tk'])).toBeUndefined()
  expect(tkUseOf(['tk', 'super'])).toBeUndefined()
  expect(tkUseOf(['tk', 'dep', 'tree', 'x'])).toBeUndefined()
  expect(tkUseOf(['tk', 'dep', 'cycle'])).toBeUndefined()
  expect(tkUseOf(['tk', 'super', 'dep', 'tree', 'x'])).toBeUndefined()
})

test('tkUseOf names any other subcommand, super read as the one after it', () => {
  for (const sub of ['close', 'start', 'status', 'reopen', 'link', 'undep', 'set', 'edit']) expect(tkUseOf(['tk', sub, 'x'])).toStrictEqual({ label: `tk ${sub}` })
  expect(tkUseOf(['tk', 'super', 'status', 'x-ab12', 'open'])).toStrictEqual({ label: 'tk status' })
  expect(tkUseOf(['tk', 'dep', 'x', 'y'])).toStrictEqual({ label: 'tk dep' })
  expect(tkUseOf(['tk', 'dep'])).toStrictEqual({ label: 'tk dep' })
  // tree and cycle are allowed only after dep.
  expect(tkUseOf(['tk', 'close', 'tree'])).toStrictEqual({ label: 'tk close' })
  expect(tkUseOf(['tk', 'start', 'cycle'])).toStrictEqual({ label: 'tk start' })
  // super is read only right after tk.
  expect(tkUseOf(['tk', 'show', 'super'])).toBeUndefined()
})

test('tkUseOf finds tk by its basename, after assignments, env and a group\'s opening', () => {
  const lines = [['/usr/local/bin/tk', 'close'], ['env', 'A=1', '/usr/local/bin/tk', 'close'], ['/usr/bin/env', 'tk', 'close'], ['A=1', 'tk', 'close'], ['(', 'tk', 'close'], ['{', 'tk', 'close'], ['!', 'tk', 'close'], ['!{tk', 'close'], ['', 'tk', 'close']]
  expect(lines.map(words => tkUseOf(words))).toStrictEqual(lines.map(() => ({ label: 'tk close' })))
  for (const words of [['echo', 'tk', 'close'], ['tkx', 'close'], ['atk', 'close'], ['tk/', 'close'], ['1A=1', 'tk', 'close'], []]) expect(tkUseOf(words)).toBeUndefined()
})

// The reserved words a command can follow, each passed over before the command name.
const RESERVED_WORDS = ['if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time']

test('tk and git are found after a reserved word that begins a command', () => {
  expect(RESERVED_WORDS.map(w => [w, tkUseOf([w, 'tk', 'close', 'x'])])).toStrictEqual(RESERVED_WORDS.map(w => [w, { label: 'tk close' }]))
  expect(RESERVED_WORDS.map(w => [w, deniedGitOf([w, 'git', 'commit'])])).toStrictEqual(RESERVED_WORDS.map(w => [w, 'commit']))
  // More than one, and with `!` after.
  expect(tkUseOf(['if', '!', 'tk', 'close', 'x'])).toStrictEqual({ label: 'tk close' })
  expect(deniedGitOf(['while', 'time', 'git', 'push'])).toBe('push')
  // Only at the front: as an argument a reserved word is a word.
  expect(tkUseOf(['echo', 'do', 'tk', 'close'])).toBeUndefined()
  expect(deniedGitOf(['echo', 'then', 'git', 'commit'])).toBeUndefined()
  expect(tkUseOf(['tk', 'show', 'do'])).toBeUndefined()
})

test('tkUseOf reads a create\'s --parent as tk does: the last one, never an option\'s value', () => {
  expect(tkUseOf(['tk', 'create', 't'])).toStrictEqual({ label: 'tk create', parent: undefined })
  expect(tkUseOf(['tk', 'create', '-d', '$(cat .tmp/d.md)', 't', '--parent', BACKLOG])).toStrictEqual({ label: 'tk create', parent: BACKLOG })
  expect(tkUseOf(['tk', 'super', 'create', 't', '--parent', RUN_EPIC, '--parent', BACKLOG])).toStrictEqual({ label: 'tk create', parent: BACKLOG })
  expect(tkUseOf(['tk', 'create', '--parent', BACKLOG, '--parent', RUN_EPIC])).toStrictEqual({ label: 'tk create', parent: RUN_EPIC })
  expect(tkUseOf(['tk', 'create', '--parent'])).toStrictEqual({ label: 'tk create', parent: undefined })
  // Each option that takes a value takes the word after it: here `--parent`, so BACKLOG is the title.
  const valued = ['-d', '--description', '--design', '--acceptance', '-p', '--priority', '-t', '--type', '-a', '--assignee', '--external-ref', '--tags']
  expect(valued.map(option => [option, tkUseOf(['tk', 'create', option, '--parent', BACKLOG])])).toStrictEqual(
    valued.map(option => [option, { label: 'tk create', parent: undefined }]),
  )
  expect(tkUseOf(['tk', 'create', '--parent', '--parent', BACKLOG])).toStrictEqual({ label: 'tk create', parent: '--parent' })
})

// ---------- the role a failed guard acts on ----------

// A stand-in for `$` with just what role.ts asks: the environment (refused when null), the stored
// role, and the debug log.
function roleWorld(env: Record<string, string> | null, stored?: Role) {
  const $ = {
    env: {
      get: async (name: string) => {
        if (env === null) throw new Error('env.get: refused')
        return env[name]
      },
    },
    state: {
      get: async () => ({ value: stored ?? null, version: 0 }),
      set: async () => ({ isSet: true, version: 1 }),
    },
    ui: { log: () => {} },
  }
  return $ as unknown as EngineInterface
}

test('AC: a failed guard refuses in a side session, from the role this load resolved', async () => {
  forgetRole()
  await role(roleWorld(SIDE_ENV))
  expect(await isSideOnFailure(roleWorld(MAIN_ENV))).toBe(true)
  forgetRole()
  await role(roleWorld(MAIN_ENV))
  expect(await isSideOnFailure(roleWorld(SIDE_ENV))).toBe(false)
  forgetRole()
})

test('AC: before the role is resolved, a failed guard refuses when role.ts resolves side', async () => {
  forgetRole()
  expect(await isSideOnFailure(roleWorld(SIDE_ENV))).toBe(true)
  forgetRole()
  expect(await isSideOnFailure(roleWorld(MAIN_ENV))).toBe(false)
  forgetRole()
  // The environment can't be read: the stored role, and with none, not side.
  expect(await isSideOnFailure(roleWorld(null, { kind: 'side', sideTicket: 'x-ab12' }))).toBe(true)
  expect(await isSideOnFailure(roleWorld(null))).toBe(false)
  // A role of kind side that names no ticket is no side session, as side.ts reads it.
  expect(await isSideOnFailure(roleWorld(null, { kind: 'side' }))).toBe(false)
  forgetRole()
})

test('the guard\'s catch replays a call it let through, refuses in a side session and lets a main one run', async () => {
  const calls: string[] = []
  const next = (called: boolean) => {
    const run = async (e: string) => {
      calls.push(e)
      return { result: 'ran' }
    }
    return Object.assign(run, { called })
  }
  forgetRole()
  await role(roleWorld(SIDE_ENV))
  expect(await onGuardFailure(roleWorld(SIDE_ENV), 'e1', next(true))).toStrictEqual({ result: 'ran' })
  expect(await onGuardFailure(roleWorld(SIDE_ENV), 'e2', next(false))).toStrictEqual(FAILED)
  forgetRole()
  await role(roleWorld(MAIN_ENV))
  expect(await onGuardFailure(roleWorld(MAIN_ENV), 'e3', next(false))).toStrictEqual({ result: 'ran' })
  expect(await onGuardFailure(roleWorld(MAIN_ENV), 'e4', next(true))).toStrictEqual({ result: 'ran' })
  expect(calls).toStrictEqual(['e1', 'e3', 'e4'])
  forgetRole()
})

// placeOf against a stand-in stat that looks a path up by its spelling, folding nothing: the
// engine's stat folds `.` and `..` first, so the hook tests can't tell placeOf's own folding apart.
function rawStat(paths: Record<string, string>) {
  const $ = {
    fs: {
      stat: async (path: string) => {
        const real = paths[path]
        if (real === undefined) throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
        return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: real }
      },
    },
  }
  return $ as unknown as EngineInterface
}

test('placeOf folds . itself and refuses any .., whatever the stat beneath folds', async () => {
  const $ = rawStat({ '/': '/', '/repo': '/repo', '/repo/.tmp': '/repo/.tmp' })
  expect(await placeOf($, '/repo/./.tmp/./x.md')).toBe('/repo/.tmp/x.md')
  expect(await placeOf($, '/repo/.tmp/x/../../src/a.ts')).toBeUndefined()
  expect(await placeOf($, '/repo/.tmp/../.tmp/a.md')).toBeUndefined()
  expect(await placeOf($, '/repo//.tmp/a.md')).toBe('/repo/.tmp/a.md')
})

// ---------- writes in a side session (D5) ----------

test('AC: in a side session, after a reload, Edit or Write outside .tmp/ is refused, naming the ticket', async ($, on) => {
  const w = world(on, SIDE_ENV)
  for (const result of [await edit($, 'src/a.ts'), await write($, 'src/a.ts'), await write($, '/repo/src/a.ts'), await notebook($, '/repo/n.ipynb')]) {
    expect(denial(result)).toContain('side agent for ticket x-ab12')
    expect(denial(result)).toContain('may write files only under `.tmp/` (/repo/.tmp/)')
  }
  expect(denial(await write($, '/repo/src/a.ts'))).toContain('/repo/src/a.ts is not there')
  expect(w.ran).toStrictEqual([])
  // No run lookup for a write.
  expect(w.runs).toStrictEqual([])
})

test('AC: a Write to <root>/.tmp/ runs, also before .tmp/ exists', async ($, on) => {
  const w = world(on, SIDE_ENV)
  expect(denial(await write($, '/repo/.tmp/desc-1.md'))).toBeUndefined()
  w.paths['/repo/.tmp'] = '/repo/.tmp'
  expect(denial(await write($, '/repo/.tmp/desc-2.md'))).toBeUndefined()
  expect(denial(await edit($, '/repo/.tmp/sub/deeper/x.md'))).toBeUndefined()
  expect(denial(await notebook($, '/repo/.tmp/n.ipynb'))).toBeUndefined()
  // `.` and doubled slashes are folded.
  expect(denial(await write($, '/repo/./.tmp//x.md'))).toBeUndefined()
  expect(w.ran).toStrictEqual(['Write /repo/.tmp/desc-1.md', 'Write /repo/.tmp/desc-2.md', 'Edit /repo/.tmp/sub/deeper/x.md', 'NotebookEdit /repo/.tmp/n.ipynb', 'Write /repo/./.tmp//x.md'])
})

test('a session started in the usual way guards the same', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(denial(await write($, '/repo/src/a.ts'))).toContain('side agent for ticket x-ab12')
  expect(denial(await write($, '/repo/.tmp/a.md'))).toBeUndefined()
  expect(w.ran).toStrictEqual(['Write /repo/.tmp/a.md'])
})

test('the root and the target are both judged by where they land', async ($, on) => {
  // The session root is a link: its .tmp/ is where the link leads, by either spelling.
  const w = world(on, SIDE_ENV, { paths: { '/': '/', '/repo': '/private/repo', '/private': '/private', '/private/repo': '/private/repo' } })
  expect(denial(await write($, '/repo/.tmp/a.md'))).toBeUndefined()
  expect(denial(await write($, '/private/repo/.tmp/b.md'))).toBeUndefined()
  expect(denial(await write($, '/private/repo/c.md'))).toContain('side agent for ticket x-ab12')
  expect(w.ran).toStrictEqual(['Write /repo/.tmp/a.md', 'Write /private/repo/.tmp/b.md'])
})

test('a link inside .tmp/ that leads out of it is outside', async ($, on) => {
  const w = world(on, SIDE_ENV)
  w.paths['/repo/.tmp'] = '/repo/.tmp'
  w.paths['/repo/.tmp/out'] = '/repo/src'
  w.paths['/repo/.tmp/in'] = '/repo/.tmp/sub'
  expect(denial(await write($, '/repo/.tmp/out/a.ts'))).toContain('side agent for ticket x-ab12')
  expect(denial(await write($, '/repo/.tmp/in/a.md'))).toBeUndefined()
  expect(w.ran).toStrictEqual(['Write /repo/.tmp/in/a.md'])
})

test('a path that cannot be placed is outside: a .., a ~, a dangling link, a root that leads nowhere', async ($, on) => {
  const w = world(on, SIDE_ENV)
  expect(denial(await write($, '/repo/.tmp/../src/a.ts'))).toContain('side agent for ticket x-ab12')
  expect(denial(await write($, '/repo/.tmp/x/../../src/a.ts'))).toContain('side agent for ticket x-ab12')
  expect(denial(await write($, '~/.tmp/a.md'))).toContain('side agent for ticket x-ab12')
  expect(denial(await write($, '.tmp/a.md'))).toContain('side agent for ticket x-ab12')
  // A relative path is not placed, even one that would land inside if read from /.
  expect(denial(await write($, 'repo/.tmp/a.md'))).toContain('side agent for ticket x-ab12')
  w.paths['/repo/.tmp'] = '/repo/.tmp'
  w.paths['/repo/.tmp/gone.md'] = null
  expect(denial(await write($, '/repo/.tmp/gone.md'))).toContain('side agent for ticket x-ab12')
  expect(denial(await write($, '/repo/.tmp/fine.md'))).toBeUndefined()
  w.paths[ROOT] = null
  expect(denial(await write($, '/repo/.tmp/fine.md'))).toContain('side agent for ticket x-ab12')
  expect(w.ran).toStrictEqual(['Write /repo/.tmp/fine.md'])
})

test('.tmp itself, and a folder whose name starts with .tmp, are outside', async ($, on) => {
  const w = world(on, SIDE_ENV)
  expect(denial(await write($, '/repo/.tmp'))).toContain('side agent for ticket x-ab12')
  expect(denial(await write($, '/repo/.tmp/'))).toContain('side agent for ticket x-ab12')
  expect(denial(await write($, '/repo/.tmpx/a.md'))).toContain('side agent for ticket x-ab12')
  expect(denial(await write($, '/repo/sub/.tmp/a.md'))).toContain('side agent for ticket x-ab12')
  expect(w.ran).toStrictEqual([])
})

// R4: the launcher names the folder it starts the side pane in (TICKET_PANES_CWD). Any `claude` a
// hook or tool starts from the pane (one that labels the pane from the temp folder, say) inherits
// it with the ticket.
const LAUNCHED = { ...SIDE_ENV, TICKET_PANES_CWD: ROOT }

test("AC: a child `claude` in another folder (the pane's ticket, a root other than the launch folder) guards nothing and looks nothing up", async ($, on) => {
  const temp = '/private/var/folders/xy/T'
  const w = world(on, LAUNCHED, { root: temp, paths: { '/': '/', [temp]: temp } })
  expect(denial(await write($, '/repo/src/a.ts'))).toBeUndefined()
  expect(denial(await edit($, `${temp}/a.ts`))).toBeUndefined()
  expect(await denials($, ['git commit -m x', 'tk close x-ab12'])).toStrictEqual([
    ['git commit -m x', undefined],
    ['tk close x-ab12', undefined],
  ])
  expect(w.ran).toStrictEqual(['Write /repo/src/a.ts', `Edit ${temp}/a.ts`, 'Bash git commit -m x', 'Bash tk close x-ab12'])
  expect(w.runs).toStrictEqual([])
})

test("AC: a child `claude -p` in the launch folder (the pane's ticket and root, drawing nowhere) guards nothing and looks nothing up", async ($, on) => {
  // Ahead of world()'s own hook, with a matcher, so it answers first.
  on('session.surfaces', {}, () => ({ value: [] }))
  const w = world(on, LAUNCHED)
  expect(denial(await write($, '/repo/src/a.ts'))).toBeUndefined()
  expect(await denials($, ['git commit -m x', 'tk close x-ab12'])).toStrictEqual([
    ['git commit -m x', undefined],
    ['tk close x-ab12', undefined],
  ])
  expect(w.ran).toStrictEqual(['Write /repo/src/a.ts', 'Bash git commit -m x', 'Bash tk close x-ab12'])
  expect(w.runs).toStrictEqual([])
})

test("the pane's own Claude, its root the launch folder, is guarded", async ($, on) => {
  const w = world(on, LAUNCHED)
  expect(denial(await write($, '/repo/src/a.ts'))).toContain('side agent for ticket x-ab12')
  expect(denial(await bash($, 'git commit -m x'))).toBeDefined()
  expect(w.ran).toStrictEqual([])
})

test('a session root at / has its .tmp/ at /.tmp/', async ($, on) => {
  const w = world(on, SIDE_ENV, { root: '/' })
  expect(denial(await write($, '/.tmp/a.md'))).toBeUndefined()
  expect(denial(await write($, '/a.md'))).toContain('(/.tmp/)')
  expect(w.ran).toStrictEqual(['Write /.tmp/a.md'])
})

// The environment refuses TICKET_PANES_TICKET, so the role is the one `$.state` kept (role.ts's
// fallback). Registered before world(), so these hooks answer first.
function keptRole(on: On, kept: Role): void {
  on('env.get', { name: 'TICKET_PANES_TICKET' }, () => ({ deny: 'the variable cannot be read here' }))
  on('state.get', roleRef, () => ({ value: { value: kept, version: 1 } }))
}

test('a kept role is judged as side.ts reads it: kind side with a ticket is guarded', async ($, on) => {
  keptRole(on, { kind: 'side', sideTicket: 'x-ab12' })
  const w = world(on, SIDE_ENV)
  expect(denial(await write($, '/repo/src/a.ts'))).toContain('side agent for ticket x-ab12')
  expect(w.ran).toStrictEqual([])
})

test('a kept role of kind main that names a ticket is not guarded', async ($, on) => {
  keptRole(on, { kind: 'main', sideTicket: 'x-ab12' })
  const w = world(on, SIDE_ENV)
  expect(denial(await write($, '/repo/src/a.ts'))).toBeUndefined()
  expect(w.ran).toStrictEqual(['Write /repo/src/a.ts'])
})

test('a kept role of kind side that names no ticket is not guarded', async ($, on) => {
  keptRole(on, { kind: 'side' })
  const w = world(on, SIDE_ENV)
  expect(denial(await write($, '/repo/src/a.ts'))).toBeUndefined()
  expect(w.ran).toStrictEqual(['Write /repo/src/a.ts'])
})

// ---------- Bash in a side session (D5, D6) ----------

const DENIED_IN_RUN = [
  'tk close x-ab12',
  'tk super status x-ab12 open',
  'env A=1 /usr/local/bin/tk start x-ab12',
  `ID=$(tk create "t" --parent ${RUN_EPIC})`,
  `tk create -d "$(cat .tmp/d.md)" "t" --parent ${RUN_EPIC}`,
  '(tk close x-ab12)',
  'tk add-note x-ab12 "n"\ntk close x-ab12',
  'tk create "t"',
  'git status && tk reopen x-ab12',
  'echo "`tk close x-ab12`"',
]

test('AC: while the side ticket is in a running run, tk beyond the allow-list is refused', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const answers = await denials($, DENIED_IN_RUN)
  for (const [command, deny] of answers) {
    expect([command, deny]).toStrictEqual([command, expect.stringContaining('side agent for ticket x-ab12, which is in the running /run-tickets run wf_1')])
  }
  expect(answers.map(([, deny]) => deny?.match(/`(tk [a-z-]+)` is refused/)?.[1])).toStrictEqual([
    'tk close',
    'tk status',
    'tk start',
    'tk create',
    'tk create',
    'tk close',
    'tk close',
    'tk create',
    'tk reopen',
    'tk close',
  ])
  expect(w.ran).toStrictEqual([])
})

test('AC: in a running run, notes, reads and follow-ups under the backlog epic run', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const commands = ['tk add-note x-ab12 "n"', 'tk epic-tree', `tk create -d "$(cat .tmp/d.md)" "t" --parent ${BACKLOG}`, 'tk show x-ab12 | head -5', 'tk dep tree x-ab12']
  expect(await denials($, commands)).toStrictEqual(commands.map(command => [command, undefined]))
  expect(w.ran).toStrictEqual(commands.map(command => `Bash ${command}`))
})

test('the run is looked up only for tk the allow-list does not take, and the backlog only then', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await denials($, ['tk show x-ab12', 'tk add-note x-ab12 "n" && tk epic-tree', 'ls -la', 'echo tk close x-ab12'])
  expect(w.runs).toStrictEqual([])
  await bash($, `tk create "t" --parent ${BACKLOG}`)
  expect(w.runs).toStrictEqual([
    { argv: LOOKUP, cwd: ROOT, timeoutMs: 20_000 },
    { argv: ['tk', 'backlog'], cwd: ROOT, timeoutMs: 10_000 },
  ])
})

test('a refusal names the backlog epic for follow-ups, and what else is allowed', async ($, on) => {
  world(on, SIDE_ENV)
  const deny = denial(await bash($, 'tk close x-ab12')) ?? ''
  expect(deny).toContain('notes (`tk add-note x-ab12 ...`)')
  expect(deny).toContain(`follow-ups under the backlog epic (\`tk create ... --parent ${BACKLOG}\`)`)
  expect(deny).toContain('reading tickets (tk show, ls, list, query, ready, blocked, closed, help, show-multi, epic-status, epic-tree, triage, dep tree, dep cycle)')
  expect(deny).not.toContain('tk backlog ensure')
})

test('with no backlog epic, or none that can be read, a create is refused and the refusal says how to make one', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const create = `tk create "t" --parent ${BACKLOG}`
  const outs: (Exit | undefined)[] = [
    { code: 1, stderr: 'tk backlog: no backlog epic\n' },
    // An answer that is no id: nothing, more than an id, or an id with an exit that is not 0.
    { code: 0, stdout: '\n' },
    { code: 0, stdout: `${BACKLOG} ${RUN_EPIC}\n` },
    { code: 3, stdout: `${BACKLOG}\n` },
    undefined,
  ]
  for (const out of outs) {
    w.backlog = out
    const deny = denial(await bash($, create)) ?? ''
    expect([out, deny]).toStrictEqual([out, expect.stringContaining('`tk backlog ensure` makes one')])
    expect(deny).toContain('`tk create ... --parent <backlog id>`, the id `tk backlog` prints')
  }
  // A create with no parent, or an empty one, is refused when there is no backlog epic either.
  w.backlog = { code: 0, stdout: '' }
  expect(denial(await bash($, 'tk create "t" --parent ""'))).toContain('`tk create` is refused')
  expect(denial(await bash($, 'tk create "t"'))).toContain('`tk create` is refused')
  w.backlog = { code: 1 }
  expect(denial(await bash($, 'tk create "t"'))).toContain('`tk create` is refused')
  expect(w.ran).toStrictEqual([])
})

test('AC: when the side ticket is not in a running run, or the lookup fails, tk close runs', async ($, on) => {
  const w = world(on, SIDE_ENV, { lookup: NOT_IN_RUN })
  expect(denial(await bash($, 'tk close x-ab12'))).toBeUndefined()
  w.lookup = LOOKUP_FAILS
  expect(denial(await bash($, 'tk close x-ab12'))).toBeUndefined()
  w.lookup = { code: 0, stdout: 'not json' }
  expect(denial(await bash($, 'tk create "t" --parent x-ef56'))).toBeUndefined()
  expect(w.ran).toStrictEqual(['Bash tk close x-ab12', 'Bash tk close x-ab12', 'Bash tk create "t" --parent x-ef56'])
  // Not in a run, no backlog is looked up.
  expect(w.runs.map(run => run.argv[0])).toStrictEqual(['run-tickets-status', 'run-tickets-status', 'run-tickets-status'])
})

test('AC: commit-making git is refused in a side session, in a run or not', async ($, on) => {
  const commands = ['git commit -m x', 'git -C . commit -m x', 'git merge main', 'git push', 'cd sub && git rebase main', 'tk show x-ab12; git cherry-pick abc']
  const w = world(on, SIDE_ENV)
  for (const lookup of [IN_RUN, NOT_IN_RUN, LOOKUP_FAILS]) {
    w.lookup = lookup
    const answers = await denials($, commands)
    expect(answers.map(([, deny]) => deny?.match(/`(git [a-z-]+)` is refused/)?.[1])).toStrictEqual([
      'git commit',
      'git commit',
      'git merge',
      'git push',
      'git rebase',
      'git cherry-pick',
    ])
    expect(answers[0]?.[1]).toContain('side agent for ticket x-ab12: it may not make or publish commits')
    expect(w.ran).toStrictEqual([])
    // Refused without a lookup.
    expect(w.runs).toStrictEqual([])
  }
})

test('tk and git in a loop or a conditional are judged like any other', async ($, on) => {
  const w = world(on, SIDE_ENV)
  expect(denial(await bash($, 'for t in x-ab12 x-cd34; do tk close "$t"; done'))).toContain('`tk close` is refused')
  expect(denial(await bash($, 'if git diff --quiet; then echo same; else git commit -am x; fi'))).toContain('`git commit` is refused')
  expect(denial(await bash($, 'while true; do git pull; done'))).toContain('`git pull` is refused')
  expect(w.ran).toStrictEqual([])
})

test('git is refused after a tk use, and a refusal names the use it refuses', async ($, on) => {
  const w = world(on, SIDE_ENV, { lookup: NOT_IN_RUN })
  expect(denial(await bash($, 'tk close x-ab12 && git commit -m x'))).toContain('`git commit` is refused')
  w.lookup = IN_RUN
  expect(denial(await bash($, `tk create "t" --parent ${BACKLOG} && tk close x-ab12`))).toContain('`tk close` is refused')
  expect(w.ran).toStrictEqual([])
})

test('git that makes no commit runs in a side session', async ($, on) => {
  const w = world(on, SIDE_ENV)
  const commands = ['git status', 'git -C . log --oneline', 'git diff main', 'git add .tmp/x']
  expect(await denials($, commands)).toStrictEqual(commands.map(command => [command, undefined]))
  expect(w.ran).toHaveLength(4)
})

test('text that cannot be split runs, in a run or not', async ($, on) => {
  const w = world(on, SIDE_ENV)
  expect(denial(await bash($, 'tk close x-ab12 "unclosed'))).toBeUndefined()
  expect(denial(await bash($, 'git commit -m "$(cat .tmp/m'))).toBeUndefined()
  expect(w.ran).toHaveLength(2)
  expect(w.runs).toStrictEqual([])
})

// ---------- a main session ----------

test('AC: in a main session every call goes on, and nothing is looked up', async ($, on) => {
  const w = world(on, MAIN_ENV)
  expect(denial(await edit($, '/repo/src/a.ts'))).toBeUndefined()
  expect(denial(await write($, 'src/a.ts'))).toBeUndefined()
  expect(denial(await notebook($, '/elsewhere/n.ipynb'))).toBeUndefined()
  for (const command of ['git commit -m x', 'tk close x-ab12', `tk create "t" --parent ${RUN_EPIC}`]) expect(denial(await bash($, command))).toBeUndefined()
  expect(w.ran).toStrictEqual([
    'Edit /repo/src/a.ts',
    'Write src/a.ts',
    'NotebookEdit /elsewhere/n.ipynb',
    'Bash git commit -m x',
    'Bash tk close x-ab12',
    `Bash tk create "t" --parent ${RUN_EPIC}`,
  ])
  expect(w.runs).toStrictEqual([])
})

// ---------- a guard that fails ----------

test('AC: if the guard throws in a side session the call is refused; in a main session it runs', async ($, on) => {
  const w = world(on, SIDE_ENV, { isRootRefused: true })
  expect(await write($, '/repo/.tmp/a.md')).toStrictEqual(FAILED)
  expect(await edit($, '/repo/src/a.ts')).toStrictEqual(FAILED)
  expect(w.ran).toStrictEqual([])
})

// The engine skips a test hook that throws, and with nothing else answering beneath the plugin,
// the guard's `next(e)` rejects: the guard fails after it let the call through.
test('a failure beneath a call the guard let through is passed on, not made a refusal', async ($, on) => {
  on('tool.call', { tool: 'Write' }, () => {
    throw new Error('the tool broke')
  })
  const w = world(on, SIDE_ENV)
  let result: unknown
  try {
    result = await write($, '/repo/.tmp/a.md')
  } catch (err) {
    result = { threw: String(err) }
  }
  expect(result).toStrictEqual({ threw: expect.stringContaining('no implementation for tool.call') })
  expect(w.ran).toStrictEqual([])
})

test('a side pane that names its launch folder is still refused when the guard fails on its root', async ($, on) => {
  const w = world(on, { ...SIDE_ENV, TICKET_PANES_CWD: ROOT }, { isRootRefused: true })
  expect(await write($, '/repo/.tmp/a.md')).toStrictEqual(FAILED)
  expect(w.ran).toStrictEqual([])
})

test('AC: with the same failure in a main session, the call runs', async ($, on) => {
  const w = world(on, MAIN_ENV, { isRootRefused: true })
  expect(denial(await write($, '/repo/.tmp/a.md'))).toBeUndefined()
  expect(w.ran).toStrictEqual(['Write /repo/.tmp/a.md'])
})
