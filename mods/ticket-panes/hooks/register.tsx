import type { EngineInterface, Register } from 'claude-code'

import { activityReady, registerActivity } from './activity'
import { bandReady, registerBand } from './band'
import { guardReady, registerGuard } from './guard'
import { linksReady, registerLinks } from './links'
import { nounReady, registerNoun } from './noun'
import { role } from './role'
import type { Role } from './role'
import { registerSide, sideReady } from './side'
import { registerSwitch, switchReady } from './switch'

// ticket-panes: tk tickets you can click. A reply that mentions tickets gets a row of buttons; a
// button opens a Claude agent for that ticket in a herdr side pane, or a read-only ticket pane
// where a side agent can't or shouldn't open.
//
// The shared rules each live in one module: tickets.ts (R1, which tokens are tickets),
// sessions.ts (R3, the conversation a click resumes), role.ts (R4, what this session is; R5, a
// counted prompt) and notify.ts (toasts). Each feature is one module with two entry points, both
// called from here: `registerX(on)` adds its hooks and `xReady($, role)` is its ready step. Its
// task replaces that one file; this one is written once (E14).
//
// The engine's scan of a hooks module shapes this:
// - `$` reaches only functions called by name (declared at the top of a file, or imported from
//   one of the mod's files), never a function value. So a ready step is a named export that
//   `runReady` calls, not a callback handed to a `ready(fn)`.
// - A `$.state` reference must be a literal or a const of the file that makes the call, and a
//   const that is also exported is refused. So each file writes its own (see role.ts).
// - A function that makes a `$.state` call must be called by name from code a hook runs: one
//   that is exported but never called that way, or passed on as a value, fails the load.
// - One plugin may register an event only once without a matcher, across all its files; a
//   second one needs a matcher (`{}` matches everything).

// Runs every module's ready step: role.ts calls it once per load, on the first resolution of the
// role. That may be inside a draw, so a ready step may start timers but never writes `$.state`.
// One step failing doesn't stop the others or the resolution; its error goes to the debug log.
export async function runReady($: EngineInterface, known: Role): Promise<void> {
  debugLog($, `ticket-panes: role ${JSON.stringify(known)}`)
  const results = await Promise.allSettled([
    nounReady($, known),
    linksReady($, known),
    guardReady($, known),
    bandReady($, known),
    sideReady($, known),
    switchReady($, known),
    activityReady($, known),
  ])
  for (const result of results) {
    if (result.status === 'rejected') debugLog($, `ticket-panes: a ready step failed: ${String(result.reason)}`)
  }
}

// A line in the debug log. The role must resolve without throwing (role.ts), so a log that
// refuses the line is passed over: the line has nowhere else to go.
function debugLog($: EngineInterface, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // Nowhere to log.
  }
}

export const register: Register = on => {
  // A new session resolves its role at once; after a reload, the first event that needs it does
  // (role.ts).
  on('session.start', async ($, e, next) => {
    await role($)
    return next(e)
  })

  registerNoun(on)
  registerLinks(on)
  registerGuard(on)
  registerBand(on)
  registerSide(on)
  registerSwitch(on)
  registerActivity(on)
}
