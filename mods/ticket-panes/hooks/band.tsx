import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { isCountedPrompt, role } from './role'
import type { Role } from './role'
import { ticketsDir } from './tickets'
import { TicketView, readTicket } from './view'

// The side session's band above the prompt: its ticket, drawn from the file (D7), above whatever
// the hooks beneath draw there (another mod's band, or the engine's own). It opens compact,
// collapses to one row on the first message the person sends, and goes back to compact from that
// row or `Show less`; `Show all` expands it. A poll of the file's mtime redraws it when the ticket
// changes (D14). Every hook here acts only in a side session (R4); a main session's band is left
// to the hooks beneath.
//
// The engine's own `[-]` mark collapses the whole band, as for any band; that is separate from the
// modes here.
//
// The mod registers `prompt.submit` and `session.end` in more than one module (side.ts does too),
// and a plugin may register an event only once without a matcher, so each hook here has one (`{}`).

// How often the poll looks at the ticket file's mtime: a change shows within 5 seconds (D14).
const POLL_MS = 2500

// This file's own references to the mod's state (role.ts says why each file writes its own). An
// unset mode reads as compact, so nothing is written at start or on a reload.
const ROLE = atom({ plugin: 'ticket-panes', key: 'role' } as const, null)
const MODE = atom({ plugin: 'ticket-panes', key: 'bandMode' } as const, 'compact')
const VERSION = atom({ plugin: 'ticket-panes', key: 'ticketVersion' } as const, 0)

// Whether this load has collapsed the band on a counted prompt since start or the last `/clear`.
// A reload starts it over (K6), so a reload can collapse the band once more.
let collapsedOnce = false
// The ticket file's mtime as the poll last saw it; undefined while the file can't be read.
let lastMtime: number | undefined

// A line in the debug log; a log that refuses it is passed over, as it has nowhere else to go.
function debugLog($: EngineInterface, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // Nowhere to log.
  }
}

// The side session's ticket (R4), or undefined in a main session. The kind decides, and a side
// role names its ticket, as side.ts reads it.
function sideTicketOf(known: Role): string | undefined {
  return known.kind === 'side' && known.sideTicket ? known.sideTicket : undefined
}

// The mtime of ticket `id`'s file (R1), or undefined when there is no tickets dir or the file
// can't be stat'd (gone, say).
async function ticketMtime($: EngineInterface, id: string): Promise<number | undefined> {
  try {
    const dir = await ticketsDir($)
    if (dir === undefined) return undefined
    return (await $.fs.stat(`${dir}/${id}.md`)).mtimeMs
  } catch {
    return undefined
  }
}

// One look at the ticket file: a changed mtime (a newer one, an older one put back, the file gone
// or back) bumps `ticketVersion`, which the band reads, so it draws again from the file. The mtime
// counts as seen only once the bump is written, so a refused write is tried again on the next look.
// Two looks that overlap cost at most an extra redraw.
async function pollTicket($: EngineInterface, id: string): Promise<void> {
  const mtime = await ticketMtime($, id)
  if (mtime === lastMtime) return
  try {
    await update($, VERSION, n => n + 1)
    lastMtime = mtime
  } catch (err) {
    debugLog($, `ticket-panes: the band could not note a change of ticket ${id}: ${String(err)}`)
  }
}

// This module's hooks, registered by register.tsx.
export function registerBand(on: On): void {
  // The band. It resolves the role first: after a reload an idle side pane gets no other event, so
  // this draw is what resolves it and starts the poll (bandReady). It reads the stored role so it
  // draws again once that is stored, and the mode and the ticket's version so it draws again when
  // either moves. It yields to a survey, and in a main session draws what the hooks beneath do.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const known = await role($)
    await read($, ROLE)
    const id = sideTicketOf(known)
    if (e.props.hasSurvey || id === undefined) return next(e)
    const mode = await read($, MODE)
    await read($, VERSION)
    const ticket = await readTicket($, id)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <TicketView
          elements={$.ui.resolve(e)}
          ticket={ticket}
          mode={mode}
          showToggles
          onExpand={() => update($, MODE, () => 'expanded')}
          onCompact={() => update($, MODE, () => 'compact')}
        />
        {await next(e)}
      </Box>
    )
  })

  // The first counted prompt (R5) since start or `/clear` collapses the band, whatever its mode;
  // later ones leave the mode as the person set it. A collapse counts as done only once its write
  // succeeds, so a refused one is logged and tried again on the next counted prompt. Either way the
  // prompt goes on to the hooks beneath (side.ts's among them).
  on('prompt.submit', {}, async ($, e, next) => {
    if (isCountedPrompt(e) && !collapsedOnce && sideTicketOf(await role($)) !== undefined) {
      try {
        await update($, MODE, () => 'collapsed')
        collapsedOnce = true
      } catch (err) {
        debugLog($, `ticket-panes: the band could not collapse: ${String(err)}`)
      }
    }
    return next(e)
  })

  // `/clear` starts a new conversation: the band opens compact again, and the next counted prompt
  // collapses it. A refused write is logged, and the end goes on to the hooks beneath.
  on('session.end', {}, async ($, e, next) => {
    if (e.reason === 'clear' && sideTicketOf(await role($)) !== undefined) {
      collapsedOnce = false
      try {
        await update($, MODE, () => 'compact')
      } catch (err) {
        debugLog($, `ticket-panes: the band could not go back to compact: ${String(err)}`)
      }
    }
    return next(e)
  })
}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known, possibly inside a draw (so it starts a timer but writes no `$.state`). It takes the
// ticket from `known`: `role($)` would wait on the resolution that is running this step. In a side
// session it notes the file's mtime, then polls it. A reload drops the timer and runs this again,
// so the poll restarts (K6).
export async function bandReady($: EngineInterface, known: Role): Promise<void> {
  const id = sideTicketOf(known)
  if (id === undefined) return
  lastMtime = await ticketMtime($, id)
  $.clock.every(POLL_MS, () => {
    void pollTicket($, id)
  })
}
