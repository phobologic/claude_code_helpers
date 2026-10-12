import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { RUN, STOP, cwdsFor, followCd, question, refusal } from './register'
import type { Agent, Verdict } from './register'

const HELD: Verdict = {
  hold: true,
  findings: [
    { kind: 'outside', path: '~/old', detail: 'a folder, 12 files, 3.0 KB' },
    { kind: 'uncommitted', path: 'src/new.ts', detail: 'untracked' },
  ],
}

// Stands in for the engine: answers the judge with `verdict`, the question with
// `answer`, the environment with `env`, and runs any Bash or Write call that gets through.
function engine(on: On, verdict: Verdict | null, answer: string, env: Record<string, string> = {}) {
  const seen = { judged: [] as unknown[], asked: [] as string[], ran: [] as string[] }
  mock.env(on, env)
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'python3') seen.judged.push(JSON.parse(e.init?.stdin ?? '{}'))
    const ok = verdict !== null
    const stdout = e.argv[0] === 'python3' && ok ? JSON.stringify(verdict) : ''
    return { value: { exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'Traceback: boom', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = e.questions[0]?.question ?? ''
    seen.asked.push(q)
    return { result: { questions: e.questions, answers: { [q]: answer } } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    seen.ran.push(e.command)
    return { result: { stdout: 'done', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'Write' }, ($, e) => {
    seen.ran.push(`Write ${e.file_path}`)
    return { result: { type: 'update', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  return seen
}

test('a command with no effects runs without the judge', async ($, on) => {
  const seen = engine(on, HELD, STOP)
  await $.tool.call({ tool: 'Bash', command: 'ls -la && git status' })
  expect(seen.judged).toEqual([])
  expect(seen.ran).toEqual(['ls -la && git status'])
})

test('a command the judge clears runs without a question', async ($, on) => {
  const seen = engine(on, { hold: false, findings: [] }, STOP)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(seen.judged).toEqual([
    { sessionRoot: '/repo', cwd: '/repo', effects: [{ op: 'delete', dir: null, paths: ['build'], recursive: true, cmd: 'rm -rf build' }] },
  ])
  expect(seen.asked).toEqual([])
  expect(seen.ran).toEqual(['rm -rf build'])
})

test('a held command runs only when the person picks Run it', async ($, on) => {
  const seen = engine(on, HELD, RUN)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/old src/new.ts' })
  expect(seen.asked).toEqual([question('rm -rf ~/old src/new.ts', HELD)])
  expect(seen.ran).toEqual(['rm -rf ~/old src/new.ts'])
})

test("a held command is refused on Don't run it, and Claude is told what it would have touched", async ($, on) => {
  const seen = engine(on, HELD, STOP)
  const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/old src/new.ts' })
  expect(seen.ran).toEqual([])
  expect(JSON.stringify(result)).toContain('the user chose not to run it')
  expect(JSON.stringify(result)).toContain('~/old: a folder, 12 files')
})

test('a free-text answer refuses the command and is passed on to Claude', async ($, on) => {
  const seen = engine(on, HELD, 'use git stash instead')
  const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/old' })
  expect(seen.ran).toEqual([])
  expect(JSON.stringify(result)).toContain('the user answered: use git stash instead')
})

test('when the judge fails, the command is held with the reason', async ($, on) => {
  const seen = engine(on, null, STOP)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(seen.ran).toEqual([])
  expect(seen.asked[0]).toContain("Blast Radius couldn't check it (Traceback: boom)")
})

// zsh splits no variable, so rm gets the one path `a b`; bash splits it, and so is any
// shell the session doesn't name as zsh read.
const SHELL_CASES: [Record<string, string>, string[]][] = [
  [{ SHELL: '/bin/zsh' }, ['a b']],
  [{ SHELL: '/bin/bash', CLAUDE_CODE_SHELL: '/opt/homebrew/bin/zsh' }, ['a b']],
  [{ SHELL: '/bin/zsh', CLAUDE_CODE_SHELL: '' }, ['a b']],
  // Claude Code ignores a CLAUDE_CODE_SHELL naming neither bash nor zsh, and runs SHELL.
  [{ SHELL: '/bin/zsh', CLAUDE_CODE_SHELL: '/usr/bin/fish' }, ['a b']],
  [{ SHELL: '/bin/zsh', CLAUDE_CODE_SHELL: '/bin/sh' }, ['a b']],
  [{ SHELL: '/usr/local/bin/zsh-5.9' }, ['a b']],
  [{ SHELL: '/bin/sh' }, ['a', 'b']],
  [{ SHELL: '/bin/bash' }, ['a', 'b']],
  [{ SHELL: '/bin/zsh', CLAUDE_CODE_SHELL: '/bin/bash' }, ['a', 'b']],
  [{ SHELL: '/home/zsh/bin/bash' }, ['a', 'b']],
  [{}, ['a', 'b']],
]
for (const [env, paths] of SHELL_CASES) {
  test(`a command is read with the word splitting of the session's shell: ${JSON.stringify(env)}`, async ($, on) => {
    const seen = engine(on, { hold: false, findings: [] }, STOP, env)
    await $.tool.call({ tool: 'Bash', command: 'F="a b"; rm $F' })
    expect(seen.judged).toEqual([
      { sessionRoot: '/repo', cwd: '/repo', effects: [{ op: 'delete', dir: null, paths, recursive: false, cmd: 'rm $F' }] },
    ])
    expect(seen.ran).toEqual(['F="a b"; rm $F'])
  })
}

test('a Write is judged as an overwrite of its file', async ($, on) => {
  const seen = engine(on, { hold: false, findings: [] }, STOP)
  await $.tool.call({ tool: 'Write', file_path: '/repo/a[1].md', content: 'x' })
  expect(seen.judged).toEqual([
    { sessionRoot: '/repo', cwd: '/repo', effects: [{ op: 'overwrite', dir: null, paths: ['/repo/a[[]1].md'], cmd: 'Write /repo/a[1].md' }] },
  ])
  expect(seen.ran).toEqual(['Write /repo/a[1].md'])
})

test("the session's own calls are measured from its shell's folder alone", () => {
  expect(cwdsFor(undefined, '/repo/sub', '/repo')).toEqual({ cwd: '/repo/sub' })
})

test("a subagent's calls are also measured from its last cd, and from the root when its folder is unknown", () => {
  const fresh: Agent = { label: 'impl x-2' }
  expect(cwdsFor(fresh, '/repo', '/repo')).toEqual({ cwd: '/repo', altCwds: [] })
  expect(cwdsFor({ ...fresh, lastCd: '/home/u/foo' }, '/repo/sub', '/repo')).toEqual({
    cwd: '/repo/sub', altCwds: ['/home/u/foo', '/repo'],
  })
  // A subagent with a folder of its own starts there, never in the session's root.
  expect(cwdsFor({ ...fresh, cwd: '/repo/.claude/worktrees/a' }, '/repo', '/repo')).toEqual({
    cwd: '/repo/.claude/worktrees/a', altCwds: [],
  })
  expect(cwdsFor({ ...fresh, cwd: '/wt', lastCd: '/wt/sub' }, '/repo', '/repo')).toEqual({ cwd: '/wt', altCwds: ['/wt/sub'] })
  expect(cwdsFor({ ...fresh, lastCd: { unknown: 'cd -' } }, '/repo', '/repo')).toEqual({
    cwd: '/repo', altCwds: [], lostCwd: 'the subagent ran cd -',
  })
})

test("a subagent's cd is followed from one call to the next", () => {
  const a: Agent = { label: 'x' }
  expect(followCd(a, null, '/repo')).toBe(a)
  const b = followCd(a, 'sub', '/repo')
  expect(b.lastCd).toBe('/repo/sub')
  expect(followCd(b, 'deeper', '/repo').lastCd).toBe('/repo/sub/deeper')
  expect(followCd(b, '/abs', '/repo').lastCd).toBe('/abs')
  const lost = followCd(b, { unknown: 'cd -' }, '/repo')
  expect(lost.lastCd).toEqual({ unknown: 'cd -' })
  expect(followCd(lost, 'sub', '/repo').lastCd).toEqual({ unknown: 'cd -' })
  expect(followCd(lost, '/abs', '/repo').lastCd).toBe('/abs')
})

test('the question groups findings by kind and cuts long lists', () => {
  const many: Verdict = {
    hold: true,
    findings: Array.from({ length: 9 }, (_, i) => ({ kind: 'uncommitted' as const, path: `f${i}`, detail: 'untracked' })),
  }
  const text = question('rm -rf .', many, 'impl x-2')
  expect(text.split('\n').slice(0, 4)).toEqual(['Blast Radius held a command from impl x-2:', '  rm -rf .', '', "Work git can't restore:"])
  expect(text).toContain('  and 3 more')
  expect(text.endsWith('Run it?')).toBe(true)
  expect(refusal('', many)).toContain('the question was dismissed or interrupted')
})
