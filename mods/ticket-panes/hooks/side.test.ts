import type { On, PromptComposeInput, PromptComposeSection } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import { roleRef } from './role'
import type { Role } from './role'

// side.ts through the engine: the plugin loads fresh for each test, so each starts as a reload
// would leave it (no compose yet in this load, a session record due). The test's hooks stand in
// for the world beneath the plugin: the environment, the ticket's file, the session, the store,
// and the engine's own answers to compose, submit and end.

const DIR = '/repo/.tickets'
const FILE = `${DIR}/x-ab12.md`
const KEY = `session:${DIR}:x-ab12`
const SIDE_ENV = { TICKET_PANES_TICKET: 'x-ab12', TICKETS_DIR: DIR }
const V1 = '---\nid: x-ab12\nstatus: open\n---\n# Widen the widget\n\nThe first text.'
const V2 = '---\nid: x-ab12\nstatus: in_progress\n---\n# Widen the widget\n\nThe second text.'

const COMPOSE: PromptComposeInput = {
  model: 'claude-test',
  promptModel: 'claude-test',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
}
const BASE: PromptComposeSection = { id: 'intro', text: 'You are Claude Code.', scope: 'shared' }
const ORIGIN = { kind: 'composer' } as const

type Ticket = { mtimeMs: number; text: string }
type World = {
  // The ticket's file, or undefined while it is gone.
  ticket: Ticket | undefined
  sessionId: string
  // The `context` each prompt reached the engine with.
  contexts: (readonly string[] | undefined)[]
  // Every `$.store.set`, as key and value.
  records: { key: string; value: unknown }[]
  // How many store writes to refuse before taking them.
  storeRefusals: number
  // The file as it becomes just after the next read answers: a change landing between a stat and
  // its read.
  afterRead?: Ticket
  // Every line the plugin logged.
  logs: string[]
}

// Answers what the plugin asks of the world beneath it. Only the ticket's file exists: any other
// path, the tickets folders a walk looks for included, is missing. With `kept`, the environment
// refuses TICKET_PANES_TICKET, so the role is the one `$.state` kept (role.ts's fallback).
function world(on: On, env: Record<string, string>, kept?: Role): World {
  const w: World = { ticket: { mtimeMs: 100, text: V1 }, sessionId: 'S1', contexts: [], records: [], storeRefusals: 0, logs: [] }
  if (kept === undefined) {
    mock.env(on, env)
  } else {
    on('env.get', ($, e) => (e.name === 'TICKET_PANES_TICKET' ? { deny: 'the variable cannot be read here' } : { value: env[e.name] }))
    on('state.get', roleRef, () => ({ value: { value: kept, version: 1 } }))
  }
  mock.clock(on, { now: 1_000_000 })
  on('fs.stat', ($, e) => {
    if (e.path !== FILE || w.ticket === undefined) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
    return { value: { kind: 'file', size: w.ticket.text.length, mtimeMs: w.ticket.mtimeMs, isLink: false } }
  })
  on('fs.read', ($, e) => {
    if (e.path !== FILE || w.ticket === undefined) return { deny: `ENOENT: no such file or directory, open '${e.path}'` }
    const text = w.ticket.text
    if (w.afterRead !== undefined) {
      w.ticket = w.afterRead
      w.afterRead = undefined
    }
    return { value: text }
  })
  on('session.id', () => ({ value: w.sessionId }))
  on('session.root', () => ({ value: '/repo' }))
  on('store.set', ($, e) => {
    if (w.storeRefusals > 0) {
      w.storeRefusals -= 1
      return { deny: 'the store refused the write' }
    }
    w.records.push({ key: e.key, value: e.value })
    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: [BASE] }))
  on('prompt.submit', ($, e) => {
    w.contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  return w
}

// A new session starting; an enable or a worker respawn raises it too, after this conversation's
// compose may already have run.
async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

async function compose($: Engine, traits: PromptComposeInput['traits'] = []): Promise<readonly PromptComposeSection[]> {
  return (await $.prompt.compose({ ...COMPOSE, traits })).sections
}

// A prompt the person typed (R5's counted prompt), with `context` when another hook attached some.
async function say($: Engine, context?: readonly string[]): Promise<void> {
  await $.prompt.submit({ text: 'what next?', wait: false, origin: ORIGIN, ...(context ? { context } : {}) })
}

async function slash($: Engine, name: string): Promise<void> {
  await $.prompt.submit({ text: `/${name}`, command: { name, args: '' }, wait: false, origin: ORIGIN })
}

async function end($: Engine, reason: 'clear' | 'resume' | 'other', sessionId: string): Promise<void> {
  await $.session.end({ reason, sessionId, resume: { id: sessionId } })
}

function change(w: World, mtimeMs: number, text: string): void {
  w.ticket = { mtimeMs, text }
}

function note(text: string): string {
  return `Ticket x-ab12 changed; its current text:\n\n${text}`
}

// ---------- the system prompt ----------

test("AC: a side session's composed prompt ends with a section holding the ticket's text and its rules", async ($, on) => {
  world(on, SIDE_ENV)
  const sections = await compose($)
  expect(sections).toHaveLength(2)
  expect(sections[0]).toEqual(BASE)
  const side = sections[1]
  expect(side?.id).toBe('ticket-panes:side')
  expect(side?.scope).toBe('session')
  const text = side?.text ?? ''
  expect(text).toContain('side agent for tk ticket x-ab12')
  expect(text).toContain(`\`${FILE}\``)
  expect(text).toContain(`<ticket-file>\n${V1}\n</ticket-file>`)
  expect(text).toContain('must not edit')
  expect(text).toContain('backlog epic')
  expect(text).toContain('`.tmp/`')
  expect(text).toContain('must not commit or push')
  expect(text).toContain('no status changes')
  expect(text).toContain('Ticket x-ab12 changed; its current text:')
})

test("AC: a main session's composed prompt has no ticket section", async ($, on) => {
  world(on, { TICKETS_DIR: DIR, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })
  expect(await compose($)).toEqual([BASE])
})

test('a kept role of kind side reads as the side session it was', async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR }, { kind: 'side', sideTicket: 'x-ab12' })
  expect((await compose($))[1]?.id).toBe('ticket-panes:side')
  await say($)
  expect(w.records).toHaveLength(1)
})

// The kind decides, and a side role names its ticket: a kept role with one but not the other is
// no side session, so nothing here acts on it.
test('a kept role of kind main that names a ticket is a main session: no section, note or record', async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR }, { kind: 'main', sideTicket: 'x-ab12' })
  expect(await compose($)).toEqual([BASE])
  await say($)
  expect(w.contexts).toEqual([undefined])
  expect(w.records).toEqual([])
})

test('a kept role of kind side that names no ticket does nothing either', async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR }, { kind: 'side' })
  expect(await compose($)).toEqual([BASE])
  await say($)
  expect(w.contexts).toEqual([undefined])
  expect(w.records).toEqual([])
})

test("a ticket file that can't be read still leaves the rules, and says where the text is", async ($, on) => {
  const w = world(on, SIDE_ENV)
  w.ticket = undefined
  const text = (await compose($))[1]?.text ?? ''
  expect(text).toContain('must not edit')
  expect(text).toContain(`The ticket's file, \`${FILE}\`, could not be read (`)
  expect(text).toContain('ENOENT')
  expect(text).toContain('Run `tk show x-ab12` for its text.')
  expect(text).not.toContain('<ticket-file>')
})

test('with no tickets folder at all, the section says so and keeps the rules', async ($, on) => {
  world(on, { TICKET_PANES_TICKET: 'x-ab12' })
  const text = (await compose($))[1]?.text ?? ''
  expect(text).toContain('backlog epic')
  expect(text).toContain("The ticket's file could not be read (no tickets folder was found, or the id is not a tk id). Run `tk show x-ab12` for its text.")
})

test('a side ticket no tk id could be names no file: the section says it could not be read, and nothing outside the tickets dir is read', async ($, on) => {
  // Ahead of the world's own fs hooks, so it sees every look; the world registers the bare
  // events, so these have a matcher.
  const looked: string[] = []
  on('fs.stat', {}, ($, e, next) => {
    looked.push(`stat ${e.path}`)
    return next(e)
  })
  on('fs.read', {}, ($, e, next) => {
    looked.push(`read ${e.path}`)
    return next(e)
  })
  const w = world(on, { TICKET_PANES_TICKET: '../x', TICKETS_DIR: DIR })
  const text = (await compose($))[1]?.text ?? ''
  expect(text).toContain('must not edit')
  expect(text).toContain("The ticket's file could not be read (no tickets folder was found, or the id is not a tk id). Run `tk show ../x` for its text.")
  await say($)
  expect(w.contexts).toEqual([undefined])
  expect(looked).toEqual([])
})

// ---------- ticket changes as notes (D16) ----------

test('AC: a change between two counted prompts reaches the second as a note; no change, no note', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  await say($)
  expect(w.contexts).toEqual([undefined])
  change(w, 200, V2)
  await say($)
  expect(w.contexts[1]).toEqual([note(V2)])
  expect(w.contexts[1]?.[0]).toStartWith('Ticket x-ab12 changed')
  // Sent once: the next prompt, with the file as it was, carries nothing.
  await say($)
  expect(w.contexts[2]).toBeUndefined()
})

test('the note joins the context other hooks attached, after it', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  change(w, 200, V2)
  await say($, ['from another hook'])
  expect(w.contexts).toEqual([['from another hook', note(V2)]])
})

test('a slash command or a hidden prompt carries no note and leaves the change for the next counted prompt', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  change(w, 200, V2)
  await slash($, 'model')
  await $.prompt.submit({ text: 'a hidden prompt', isMeta: true, wait: false, origin: ORIGIN })
  expect(w.contexts).toEqual([undefined, undefined])
  await say($)
  expect(w.contexts[2]).toEqual([note(V2)])
})

test("a new session's first counted prompt, ahead of its first compose, carries no note: the compose brings the text", async ($, on) => {
  const w = world(on, SIDE_ENV)
  await start($)
  await say($)
  expect(w.contexts).toEqual([undefined])
  expect((await compose($))[1]?.text).toContain(`<ticket-file>\n${V1}\n</ticket-file>`)
  await say($)
  change(w, 200, V2)
  await say($)
  expect(w.contexts).toEqual([undefined, undefined, [note(V2)]])
})

test('in a new session, /context ahead of the first compose leaves that compose due', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await start($)
  await compose($, ['analysis'])
  await say($)
  expect(w.contexts).toEqual([undefined])
})

test('a session.start that no compose follows (an enable, a respawn) still lets later notes through', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await start($)
  await say($)
  change(w, 200, V2)
  await say($)
  expect(w.contexts[1]).toEqual([note(V2)])
})

test('a compose ahead of session.start skips at most one note', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  await start($)
  await say($)
  change(w, 200, V2)
  await say($)
  expect(w.contexts[1]).toEqual([note(V2)])
})

test('a new session still records its first counted prompt, ahead of its first compose', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await start($)
  await say($)
  expect(w.records).toEqual([{ key: KEY, value: { sessionId: 'S1', cwd: '/repo' } }])
})

test("after a reload, with no compose in this load, the first counted prompt sends the ticket's text", async ($, on) => {
  const w = world(on, SIDE_ENV)
  await say($)
  await say($)
  expect(w.contexts).toEqual([[note(V1)], undefined])
})

test('a compose that could not read the file leaves the text to the first counted prompt that can', async ($, on) => {
  const w = world(on, SIDE_ENV)
  w.ticket = undefined
  await compose($)
  await say($)
  change(w, 100, V1)
  await say($)
  expect(w.contexts).toEqual([undefined, [note(V1)]])
})

test('a later compose that could not read the file drops the baseline, so the text follows as a note', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  w.ticket = undefined
  await compose($)
  // Back as it was: the agent's prompt no longer holds it, so the next counted prompt sends it.
  change(w, 100, V1)
  await say($)
  expect(w.contexts).toEqual([[note(V1)]])
})

test('a file gone at a counted prompt sends no note; the change shows once it is back', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  w.ticket = undefined
  await say($)
  change(w, 300, V2)
  await say($)
  expect(w.contexts).toEqual([undefined, [note(V2)]])
})

test('a render that only measures the prompt (/context) shows the new text but still leaves the note to come', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  change(w, 200, V2)
  expect((await compose($, ['analysis']))[1]?.text).toContain(V2)
  await say($)
  expect(w.contexts).toEqual([[note(V2)]])
})

test('a teammate render leaves the note for the main agent', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  change(w, 200, V2)
  await compose($, ['teammate'])
  await say($)
  expect(w.contexts).toEqual([[note(V2)]])
})

// Another plugin measuring the prompt with `$.prompt.compose()`: composed for nobody to send. It
// passes every compose fact, as the engine's own would, so ticket-panes' hook runs on it. The
// fixture runs on its own, so it cannot use this file's COMPOSE.
const MEASURER: Plugin = {
  name: 'measurer',
  register(on) {
    on('prompt.suggest', async $ => {
      await $.prompt.compose({ model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
      return { isShown: false }
    })
  },
}

test('a compose another plugin asks for leaves the note to come', { plugins: [MEASURER] }, async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  change(w, 200, V2)
  await $.prompt.suggest({ text: 'run the tests' })
  await say($)
  expect(w.contexts).toEqual([[note(V2)]])
})

test('a change landing between the stat and the read is sent again', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  change(w, 150, V2)
  w.afterRead = { mtimeMs: 200, text: V1 }
  await say($)
  await say($)
  expect(w.contexts).toEqual([[note(V2)], [note(V1)]])
})

test('a file put back to an older mtime is still a change', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  change(w, 50, V2)
  await say($)
  expect(w.contexts).toEqual([[note(V2)]])
})

test("AC: after a note and then /clear, the first counted prompt carries the ticket's current text", async ($, on) => {
  const w = world(on, SIDE_ENV)
  await start($)
  await compose($)
  change(w, 200, V2)
  await say($)
  expect(w.contexts[0]).toEqual([note(V2)])
  await end($, 'clear', 'S1')
  await say($)
  expect(w.contexts[1]).toEqual([note(V2)])
  await say($)
  expect(w.contexts[2]).toBeUndefined()
})

test('AC: when compose runs again after /clear, the new prompt holds the current text and no note follows', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  change(w, 200, V2)
  await say($)
  await end($, 'clear', 'S1')
  expect((await compose($))[1]?.text).toContain(`<ticket-file>\n${V2}\n</ticket-file>`)
  await say($)
  expect(w.contexts).toEqual([[note(V2)], undefined])
})

test('after /clear with the ticket as the last compose embedded it, no note is sent', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  await say($)
  await end($, 'clear', 'S1')
  await say($)
  expect(w.contexts).toEqual([undefined, undefined])
})

test('/resume puts the baseline back to the last compose, as /clear does', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  change(w, 200, V2)
  await say($)
  await end($, 'resume', 'S1')
  await say($)
  expect(w.contexts).toEqual([[note(V2)], [note(V2)]])
})

test('a session that ends for another reason leaves the baseline where it was', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await compose($)
  change(w, 200, V2)
  await say($)
  await end($, 'other', 'S1')
  await say($)
  expect(w.contexts).toEqual([[note(V2)], undefined])
})

test('after a compaction, the next counted prompt carries the current text again', async ($, on) => {
  const w = world(on, SIDE_ENV)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'a summary', toolUses: [] }] }))
  await compose($)
  change(w, 200, V2)
  await say($)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'what next?', toolUses: [] }] })
  await say($)
  expect(w.contexts).toEqual([[note(V2)], [note(V2)]])
})

test('after a compaction, a ticket as the last compose embedded it sends no note', async ($, on) => {
  const w = world(on, SIDE_ENV)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'a summary', toolUses: [] }] }))
  await compose($)
  await say($)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'what next?', toolUses: [] }] })
  await say($)
  expect(w.contexts).toEqual([undefined, undefined])
})

test('a precompute installs nothing, so the note already sent stands', async ($, on) => {
  const w = world(on, SIDE_ENV)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'a summary', toolUses: [] }] }))
  await compose($)
  change(w, 200, V2)
  await say($)
  await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'what next?', toolUses: [] }] })
  await say($)
  expect(w.contexts).toEqual([[note(V2)], undefined])
})

test("a subagent's compaction or a skipped one leaves the main conversation's baseline", async ($, on) => {
  const w = world(on, SIDE_ENV)
  let isSkip = false
  on('session.compact', () => (isSkip ? { skip: 'off' } : { messages: [{ role: 'user', text: 'a summary', toolUses: [] }] }))
  await compose($)
  change(w, 200, V2)
  await say($)
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: [{ role: 'user', text: 'what next?', toolUses: [] }] })
  await say($)
  isSkip = true
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'what next?', toolUses: [] }] })
  await say($)
  expect(w.contexts).toEqual([[note(V2)], undefined, undefined])
})

test('a main session gets no notes', async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR })
  await say($)
  change(w, 200, V2)
  await say($)
  expect(w.contexts).toEqual([undefined, undefined])
})

// ---------- the session record (R3) ----------

test('AC: the first counted prompt records the session id and root for the ticket; later ones do not', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await say($)
  expect(w.records).toEqual([{ key: KEY, value: { sessionId: 'S1', cwd: '/repo' } }])
  await say($)
  expect(w.records).toHaveLength(1)
})

test('AC: /model alone records nothing; the next counted prompt records', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await slash($, 'model')
  expect(w.records).toEqual([])
  await say($)
  expect(w.records).toEqual([{ key: KEY, value: { sessionId: 'S1', cwd: '/repo' } }])
})

test('AC: after /clear or /resume, the next counted prompt records the id then current', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await say($)
  await end($, 'clear', 'S1')
  w.sessionId = 'S2'
  await slash($, 'model')
  expect(w.records).toHaveLength(1)
  await say($)
  await say($)
  await end($, 'resume', 'S2')
  w.sessionId = 'S3'
  await say($)
  expect(w.records.map(r => r.value)).toEqual([
    { sessionId: 'S1', cwd: '/repo' },
    { sessionId: 'S2', cwd: '/repo' },
    { sessionId: 'S3', cwd: '/repo' },
  ])
})

test('a session that ends for another reason is not recorded again', async ($, on) => {
  const w = world(on, SIDE_ENV)
  await say($)
  await end($, 'other', 'S1')
  await say($)
  expect(w.records).toHaveLength(1)
})

test('a record the store refuses is tried again on the next counted prompt, and the note still goes', async ($, on) => {
  const w = world(on, SIDE_ENV)
  w.storeRefusals = 1
  await say($)
  expect(w.records).toEqual([])
  expect(w.logs.some(l => l.includes('could not be recorded') && l.includes('the store refused the write'))).toBe(true)
  expect(w.contexts).toEqual([[note(V1)]])
  await say($)
  expect(w.records).toEqual([{ key: KEY, value: { sessionId: 'S1', cwd: '/repo' } }])
})

test('with no tickets folder, nothing is recorded', async ($, on) => {
  const w = world(on, { TICKET_PANES_TICKET: 'x-ab12' })
  await say($)
  expect(w.records).toEqual([])
})

test('a main session records nothing', async ($, on) => {
  const w = world(on, { TICKETS_DIR: DIR, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })
  await say($)
  expect(w.records).toEqual([])
})
