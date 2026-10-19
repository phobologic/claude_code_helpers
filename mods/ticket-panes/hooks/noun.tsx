import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, UiOpenResult } from 'claude-code'

import { syncActivity } from './activity'
import { beginNotices, flushNotices, notify } from './notify'
import { role } from './role'
import type { Role } from './role'
import { openSidePane } from './route'
import type { OpenResult } from './route'
import { isTicket } from './tickets'
import { TicketView, readTicket } from './view'

// The `$.ticketPanes` noun (K2), which the mod's ticket buttons and other plugins call, and the
// read-only ticket pane. `available({})` answers true, so a caller can probe for the mod (E1).
// `open({ id })` opens ticket `id` where this session can show it:
// - One open runs at a time (E10): a call while one runs toasts `still opening <id>` and does
//   nothing else.
// - The id must be a ticket (R1, E17), or the call toasts `not a ticket: <id>`.
// - A main session in herdr (R4) opens the ticket's side pane (route.ts) and, once that shows the
//   ticket, its run activity (activity.ts). When the side pane fails, the toast names what failed
//   and the read-only pane opens instead (D13).
// - A side session (D12) or a session not in herdr (D9) opens the read-only pane: the ticket drawn
//   from its file with everything shown, no agent, closed with Esc.
// Every message of one open shows as one toast when it ends (notify.ts).

// The read-only pane's one id (E17).
const PANE_ID = 'ticket-panes'

// The ticket the read-only pane shows, or null while it is closed: this file's own reference
// (role.ts says why each file writes its own).
const PANE_TICKET = atom({ plugin: 'ticket-panes', key: 'paneTicket' } as const, null)

// The id of the open in progress, undefined between opens: the lock (E10). A reload starts it over
// (K6), as it does every module variable.
let opening: string | undefined

// What a failure says, on one line: the first line of its message.
function whatFailed(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().split('\n')[0] ?? ''
}

// Shows ticket `id` in the read-only pane, replacing the ticket it showed (D9). The ticket is
// written before the pane opens, so its first draw is of this ticket; an open that is refused
// puts back the ticket shown before, so the pane, open or not, still says what it shows.
async function openPane($: EngineInterface, id: string): Promise<void> {
  const shown = await read($, PANE_TICKET)
  await update($, PANE_TICKET, () => id)
  let opened: UiOpenResult
  try {
    opened = await $.ui.open({ id: PANE_ID, title: id, focus: true, closeOnEscape: true })
  } catch (error) {
    await update($, PANE_TICKET, () => shown)
    throw error
  }
  if (shown !== null && shown !== id) notify($, `Showing ${id} (replaced ${shown})`)
  if (!opened.isPlaced) notify($, `${id}: no room to show the ticket pane`)
}

// Opens ticket `id`'s side pane and, for a side pane that now shows it (opened or focused, not one
// left on another ticket or an agent outside our record), its run activity. False when the side
// pane failed: the toast names what failed (D13), and the caller opens the read-only pane.
// syncActivity never throws; it toasts its own failures (D17).
async function openSide($: EngineInterface, id: string): Promise<boolean> {
  let opened: OpenResult
  try {
    opened = await openSidePane($, id)
  } catch (error) {
    notify($, `no side pane for ${id}: ${whatFailed(error)}`)
    return false
  }
  if (opened.kind === 'opened' || opened.kind === 'focused-own') await syncActivity($, id)
  return true
}

// The open's steps, once it holds the lock. isTicket (R1) also checks the id's shape (E17): a
// token that is no tk id, `/` or `;` in it say, is no ticket, and no file is looked for. An id
// that is not a string is none either: a regular expression would read it as its text.
async function openTicket($: EngineInterface, id: unknown): Promise<void> {
  if (typeof id !== 'string' || !(await isTicket($, id))) {
    notify($, `not a ticket: ${String(id)}`)
    return
  }
  const known = await role($)
  if (known.kind === 'main' && known.herdrPaneId !== undefined && (await openSide($, id))) return
  await openPane($, id)
}

// `$.ticketPanes.open`'s body: the lock (E10), then the open with its messages collected into one
// toast. Anything else that fails is toasted by its first line; the lock is let go either way.
async function open($: EngineInterface, id: unknown): Promise<void> {
  if (opening !== undefined) {
    // This click's own answer, shown at once: through notify it would join the messages of the
    // open in flight, shown only when that ends.
    $.ui.toast(`still opening ${opening}`)
    return
  }
  opening = String(id)
  beginNotices()
  try {
    await openTicket($, id)
  } catch (error) {
    notify($, `could not open ${String(id)}: ${whatFailed(error)}`)
  } finally {
    opening = undefined
    flushNotices($)
  }
}

// This module's hooks, registered by register.tsx.
export function registerNoun(on: On): void {
  // Adds the noun to `$`. Its entry is a stub: a call reaches the hooks below, and the stub answers
  // only when no hook did (each was skipped). It then rejects, so the caller learns the call did
  // nothing, as it does when the mod is not loaded.
  on('engine.create', async ($, e, next) => ({
    ...(await next(e)),
    ticketPanes: {
      open: async () => {
        throw new Error('ticket-panes: open: no hook answered')
      },
      available: async (): Promise<true> => {
        throw new Error('ticket-panes: available: no hook answered')
      },
    },
  }))

  on('ticketPanes.available', () => ({ value: true as const }))

  on('ticketPanes.open', async ($, e) => {
    await open($, e.id)
    return { value: undefined }
  })

  // The read-only pane: the ticket from its file, expanded (everything shown, notes included) and
  // with no toggles. It reads the ticket from `$.state`, so a write of another one draws it again.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const id = await read($, PANE_TICKET)
    if (id === null) {
      const { Text } = elements
      return <Text dimColor>no ticket</Text>
    }
    return <TicketView elements={elements} ticket={await readTicket($, id)} mode="expanded" showToggles={false} />
  })

  // A closed pane shows no ticket, so the next open replaces none. A close a hook beneath refused
  // leaves the pane, and its ticket, as they were.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const closed = await next(e)
    if (closed.deny === undefined) await update($, PANE_TICKET, () => null)
    return closed
  })
}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known. It has nothing to start.
export async function nounReady($: EngineInterface, known: Role): Promise<void> {}
