import type { EngineInterface, On } from 'claude-code'

import { closeOwnPanes } from './herdr'
import { isCountedPrompt, role } from './role'
import type { Role } from './role'
import { recordSession } from './sessions'
import { ticketFile, ticketsDir } from './tickets'

// The side session's agent: its rules and the ticket's text in the system prompt (D5, D6), the
// ticket's changes as notes on the person's messages (D16), the record of the conversation a
// click on the ticket resumes (R3, E12), and its panes closing when the person leaves it. Every
// hook here acts only in a side session (R4).
//
// The mod registers `prompt.submit` and `session.end` in more than one module (the band does too),
// and a plugin may register an event only once without a matcher, so each hook here has one (`{}`).

// The system prompt section this module adds.
const SECTION_ID = 'ticket-panes:side'

// The mtime of the ticket text the agent was last given, in the system prompt or a note. A reload
// starts it over as undefined (K6), and the next counted prompt then sends the text as a note.
let baseline: number | undefined
// The mtime of the text the last compose of this load put in the system prompt: what a new
// conversation after `/clear` or `/resume` starts from, unless compose runs again for it.
let composedMtime: number | undefined
// Whether a new session's first compose may still be to come: set by `session.start`, cleared by a
// compose that is sent or by the next counted prompt. The system prompt may be composed only when
// the first request is built, after that prompt's `prompt.submit`, so that one prompt sends no
// note: the compose will carry the text itself. An enable or a worker respawn may raise
// `session.start` after this conversation's compose has run, so the flag skips only that one
// prompt, never more. `/clear` does not set it: compose may not run again then.
let isComposeDue = false
// Whether the next counted prompt records this session as the ticket's (R3): so at start, after a
// reload (recording the same id again is harmless), and after `/clear` or `/resume`.
let isRecordDue = true

type TicketText = { path: string; mtimeMs: number; text: string }
type TicketMiss = { path?: string; reason: string }

// A line in the debug log; a log that refuses it is passed over, as it has nowhere else to go.
function debugLog($: EngineInterface, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // Nowhere to log.
  }
}

// The ticket's file as it stands. Its mtime is read before its text, so a change that lands between
// the two leaves the mtime older than the text: the next prompt sends the text again rather than
// missing a change. R1 gives no file for an id no tk id could be (TICKET_PANES_TICKET holding a
// `/`, say), so nothing outside the tickets dir is read.
async function readTicket($: EngineInterface, id: string): Promise<TicketText | TicketMiss> {
  let path: string | undefined
  try {
    path = await ticketFile($, id)
    if (path === undefined) return { reason: (await ticketsDir($)) === undefined ? 'no tickets folder was found' : 'the id is not a tk id' }
    const { mtimeMs } = await $.fs.stat(path)
    const text = await $.fs.read(path)
    return { path, mtimeMs, text }
  } catch (err) {
    return { path, reason: err instanceof Error ? err.message : String(err) }
  }
}

// The section the side agent's system prompt carries: its rules (D5, D6, D16), then the ticket's
// text, or, when the file could not be read, where to get it.
function sectionText(id: string, ticket: TicketText | TicketMiss): string {
  const lines = [
    '# Ticket side agent',
    '',
    `You are the side agent for tk ticket ${id} in this repository. The person opened this session from a button for that ticket, to work on it with you.`,
    '',
    '- You may read and search the code, and run tk.',
    "- You may write files only under the repository's `.tmp/` folder, for tk description files as the global rules say. You must not edit any other file, and you must not commit or push.",
    `- While ticket ${id} is in a running /run-tickets run, a guard limits tk to reading tickets, adding notes, and filing follow-ups under the backlog epic (\`tk backlog\` gives its id): no status changes, and no tickets under the run's epic. When the guard denies a command, its reason says what is allowed. Outside a run, tk is yours to use in full.`,
    `- The ticket may change during this conversation. Its changes arrive as notes on the person's messages, starting \`Ticket ${id} changed; its current text:\`. The newest is the ticket as it stands.`,
    '',
  ]
  if ('text' in ticket) {
    lines.push(`The ticket's file, \`${ticket.path}\`, as this conversation started:`, '', '<ticket-file>', ticket.text, '</ticket-file>')
  } else {
    const where = ticket.path === undefined ? "The ticket's file" : `The ticket's file, \`${ticket.path}\`,`
    lines.push(`${where} could not be read (${ticket.reason}). Run \`tk show ${id}\` for its text.`)
  }
  return lines.join('\n')
}

// Records this session as the one a click on ticket `id` resumes (R3), when one is due. A failure
// leaves it due, for the next counted prompt.
async function recordIfDue($: EngineInterface, id: string): Promise<void> {
  if (!isRecordDue) return
  try {
    const dir = await ticketsDir($)
    if (dir === undefined) return
    await recordSession($, dir, id, { sessionId: await $.session.id(), cwd: await $.session.root() })
    isRecordDue = false
  } catch (err) {
    debugLog($, `ticket-panes: the side session could not be recorded: ${String(err)}`)
  }
}

// The note for a counted prompt (D16): the ticket's current text when its file changed since the
// agent was last given it, or when that is not known (after a reload); else undefined. Sending it
// moves the baseline. A file that cannot be read sends nothing, and neither does the one prompt
// that a new session's first compose may still follow.
async function changeNote($: EngineInterface, id: string): Promise<string | undefined> {
  if (isComposeDue) {
    isComposeDue = false
    return undefined
  }
  const ticket = await readTicket($, id)
  if (!('text' in ticket) || ticket.mtimeMs === baseline) return undefined
  baseline = ticket.mtimeMs
  return `Ticket ${id} changed; its current text:\n\n${ticket.text}`
}

// The side pane's own Claude is leaving (R4): its panes close. A main session, a child `claude`
// (R4 calls neither the side session) or a session outside herdr closes nothing.
async function closeOnExit($: EngineInterface): Promise<void> {
  const known = await role($)
  if (known.kind !== 'side' || !known.sideTicket || known.herdrPaneId === undefined) return
  await closeOwnPanes($, known.herdrPaneId)
}

// This module's hooks, registered by register.tsx.
export function registerSide(on: On): void {
  // A new session, or this one after an enable or a worker respawn: its first compose may be to
  // come, so the next counted prompt sends no note (see `isComposeDue`). register.tsx registers
  // the bare `session.start`, so this one has a matcher too.
  on('session.start', {}, ($, e, next) => {
    isComposeDue = true
    return next(e)
  })

  // The side agent's rules and its ticket. Compose runs once per conversation, so it resolves the
  // role itself: a miss here would leave the agent without its rules for the whole conversation.
  // A render this conversation's agent never reads leaves the baseline alone: one that measures
  // the prompt and sends nothing (`analysis`, as `/context` does), an in-process teammate's render
  // of its lead's prompt (`teammate`), and a plugin's `$.prompt.compose()`, which is composed for
  // nobody to send.
  on('prompt.compose', {}, async ($, e, next) => {
    const known = await role($)
    const composed = await next(e)
    if (known.kind !== 'side' || !known.sideTicket) return composed
    const ticket = await readTicket($, known.sideTicket)
    const isSent = !e.traits.includes('analysis') && !e.traits.includes('teammate') && next.origin.plugin === 'engine'
    if (isSent) {
      composedMtime = 'text' in ticket ? ticket.mtimeMs : undefined
      baseline = composedMtime
      isComposeDue = false
    }
    const section = { id: SECTION_ID, text: sectionText(known.sideTicket, ticket), scope: 'session' } as const
    return { sections: [...composed.sections, section] }
  })

  // On a counted prompt (R5): record the session when due (R3), and pass on a change of the ticket.
  on('prompt.submit', {}, async ($, e, next) => {
    if (!isCountedPrompt(e)) return next(e)
    const known = await role($)
    if (known.kind !== 'side' || !known.sideTicket) return next(e)
    await recordIfDue($, known.sideTicket)
    const note = await changeNote($, known.sideTicket)
    return next(note === undefined ? e : { ...e, context: [...(e.context ?? []), note] })
  })

  // `/clear` and `/resume` start another conversation in this process: it knows the ticket as the
  // last compose embedded it (until compose runs for it), and it is the one to record next; the
  // pane stays. When the person leaves (`prompt_input_exit`: `/exit`, ctrl+c, ctrl+d), the side
  // session closes its herdr pane, and the activity pane below it, once the engine's end step has
  // run: that close ends this process.
  on('session.end', {}, async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      baseline = composedMtime
      isRecordDue = true
    }
    const ended = await next(e)
    if (e.reason === 'prompt_input_exit') await closeOnExit($)
    return ended
  })

  // A compaction of the main conversation summarizes the notes away, and the system prompt still
  // holds the text the last compose embedded: so the next counted prompt sends the text again when
  // it changed since. A compose that runs again moves the baseline itself; without one, the worst
  // case is one extra note. A subagent's compaction (`agentId` set) and a skip change nothing. A
  // precompute installs nothing, so the notes already sent stand: the compaction that installs its
  // summary raises session.compact again, and that one moves the baseline.
  on('session.compact', {}, async ($, e, next) => {
    const result = await next(e)
    const isInstalled = e.trigger !== 'precompute' && result.skip === undefined
    if (isInstalled && e.agentId === undefined) baseline = composedMtime
    return result
  })
}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known. It has nothing to start: every hook above resolves the role itself.
export async function sideReady($: EngineInterface, known: Role): Promise<void> {}
