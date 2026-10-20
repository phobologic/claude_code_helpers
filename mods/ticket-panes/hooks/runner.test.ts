import type { EngineInterface, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { closePane, field, herdr, text } from './herdr'

// herdr.ts's runner, the one route.ts, switch.ts and activity.ts call herdr through. It runs
// against a stand-in `$` whose `process.run` gives one faked answer and records what it was asked:
// herdr answers JSON on stdout (`{ result }`), and on failure exits 1 with
// `{ error: { code, message } }` on stderr, or 2 with a usage line when it could not read the
// command.

type Asked = { argv: string[]; init?: ProcessRunInit }

function written(exitCode: number, stdout: string, stderr: string): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

// A `$` whose `process.run` answers `out`, or rejects with it when it is an Error.
function stand(out: ProcessRunResult | Error) {
  const asked: Asked[] = []
  const run = async (argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> => {
    asked.push({ argv: [...argv], init })
    if (out instanceof Error) throw out
    return out
  }
  return { $: { process: { run } } as unknown as EngineInterface, asked }
}

test('a call herdr answers gives its result, run as herdr <args> with a 10 s timeout', async () => {
  const s = stand(written(0, JSON.stringify({ id: 'cli', result: { pane: { pane_id: 'w1:p2' } } }), ''))
  expect(await herdr(s.$, ['pane', 'get', 'w1:p2'])).toStrictEqual({ isOk: true, result: { pane: { pane_id: 'w1:p2' } } })
  expect(s.asked).toEqual([{ argv: ['herdr', 'pane', 'get', 'w1:p2'], init: { timeoutMs: 10_000 } }])
})

test('a timeout given is the one the call runs with', async () => {
  const s = stand(written(0, JSON.stringify({ result: {} }), ''))
  await herdr(s.$, ['agent', 'start', 'tp-x'], 45_000)
  expect(s.asked.map(asked => asked.init)).toEqual([{ timeoutMs: 45_000 }])
})

test("a call herdr answers with output that is not JSON goes through with no result", async () => {
  const s = stand(written(0, 'pane w1:p2\n', ''))
  expect(await herdr(s.$, ['pane', 'get', 'w1:p2'])).toStrictEqual({ isOk: true, result: undefined })
})

test("AC: herdr's error gives its code and its message as the reason", async () => {
  const s = stand(written(1, '', JSON.stringify({ error: { code: 'pane_not_found', message: 'pane w1:p9 not found' }, id: 'cli' })))
  expect(await herdr(s.$, ['pane', 'get', 'w1:p9'])).toStrictEqual({ isOk: false, code: 'pane_not_found', reason: 'pane w1:p9 not found' })
})

test('an error with a code and no message gives the code, and the first line of stderr as the reason', async () => {
  const s = stand(written(1, '', `${JSON.stringify({ error: { code: 'agent_not_found' } })}\n`))
  expect(await herdr(s.$, ['agent', 'get', 'tp-x'])).toStrictEqual({
    isOk: false,
    code: 'agent_not_found',
    reason: JSON.stringify({ error: { code: 'agent_not_found' } }),
  })
})

test('a usage line (exit status 2) gives no code, and its first line as the reason', async () => {
  const s = stand(written(2, '', '  error: unexpected argument --bogus\n\nUsage: herdr pane get <PANE>\n'))
  expect(await herdr(s.$, ['pane', 'get', '--bogus'])).toStrictEqual({ isOk: false, code: undefined, reason: 'error: unexpected argument --bogus' })
})

test('a failure with nothing on stderr gives its exit status as the reason', async () => {
  const s = stand(written(3, '', ''))
  expect(await herdr(s.$, ['pane', 'close', 'w1:p2'])).toStrictEqual({ isOk: false, code: undefined, reason: 'exit status 3' })
})

test("a call that never answers (herdr missing, or past its time) gives no code, and the run's message", async () => {
  const s = stand(new Error('process.run: herdr pane get ran past its timeout'))
  expect(await herdr(s.$, ['pane', 'get', 'w1:p2'])).toStrictEqual({ isOk: false, reason: 'process.run: herdr pane get ran past its timeout' })
})

test('closePane runs herdr pane close and resolves when herdr refuses it or never answers', async () => {
  const refused = stand(written(1, '', JSON.stringify({ error: { code: 'pane_not_found', message: 'gone' } })))
  await closePane(refused.$, 'w1:p3')
  expect(refused.asked).toEqual([{ argv: ['herdr', 'pane', 'close', 'w1:p3'], init: { timeoutMs: 10_000 } }])
  const lost = stand(new Error('process.run: herdr pane close ran past its timeout'))
  await closePane(lost.$, 'w1:p3')
  expect(lost.asked.length).toBe(1)
})

test('field reads a key of an object only, and text only a string one', () => {
  expect(field({ a: 1 }, 'a')).toBe(1)
  expect(field(null, 'a')).toBeUndefined()
  expect(field('a', 'length')).toBeUndefined()
  expect(text({ a: 'x' }, 'a')).toBe('x')
  expect(text({ a: 3 }, 'a')).toBeUndefined()
  expect(text(undefined, 'a')).toBeUndefined()
})
