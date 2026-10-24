import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// Stands in for the engine: answers snapshot.py with `exitCode` and `stderr` (or throws
// `thrown`), and runs any Bash call that gets through. `seen.order` records the snapshot
// and the command in the order they happened.
function engine(on: On, exitCode = 0, stderr = '', thrown?: Error) {
  const seen = { order: [] as string[], argv: [] as string[][], cwds: [] as (string | undefined)[], toasts: [] as string[] }
  on('session.cwd', () => ({ value: '/repo/sub' }))
  on('process.run', ($, e) => {
    if (thrown) throw thrown
    seen.order.push('snapshot')
    seen.argv.push([...e.argv])
    seen.cwds.push(e.init?.cwd)
    return { value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    seen.order.push(`ran ${e.command}`)
    return { result: { stdout: 'done', stderr: '', interrupted: false } }
  })
  return seen
}

test('a snapshot is taken before the command runs, in the session folder, with the command as its reason', async ($, on) => {
  const seen = engine(on)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(seen.order).toEqual(['snapshot', 'ran rm -rf build'])
  expect(seen.argv[0]?.slice(0, 2)).toEqual(['python3', '-I'])
  expect(seen.argv[0]?.[2]).toMatch(/\/bin\/snapshot\.py$/)
  expect(seen.argv[0]?.[3]).toBe('rm -rf build')
  expect(seen.cwds).toEqual(['/repo/sub'])
  expect(seen.toasts).toEqual([])
})

test('every command gets its own snapshot', async ($, on) => {
  const seen = engine(on)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(seen.order).toEqual(['snapshot', 'ran ls', 'snapshot', 'ran git status'])
})

test('a failed snapshot still runs the command, and only the first failure is shown', async ($, on) => {
  const seen = engine(on, 1, 'fatal: Unable to create lock\n')
  const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(JSON.stringify(result)).toContain('done')
  expect(seen.order).toEqual(['snapshot', 'ran rm -rf build', 'snapshot', 'ran ls'])
  expect(seen.toasts).toEqual(['worktree-snapshots: no snapshot before this command (fatal: Unable to create lock)'])
})

test('a snapshot that cannot start at all still runs the command', async ($, on) => {
  const seen = engine(on, 0, '', new Error('python3 not found'))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(seen.order).toEqual(['ran ls'])
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toStartWith('worktree-snapshots: no snapshot before this command (')
})
