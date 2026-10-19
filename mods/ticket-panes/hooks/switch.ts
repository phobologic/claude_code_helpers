import type { EngineInterface, On } from 'claude-code'

import { agentStatus, exitAgent, isIdle, launch, updateSide } from './herdr'
import type { Side } from './herdr'
import { notify } from './notify'
import type { Role } from './role'

// Switching the side pane from its ticket to another (D3, D14). An idle side agent is closed and
// the clicked ticket opened in its place. A busy one is left alone and the person is told; a
// second click on the same ticket within 15 seconds of that toast switches anyway.

// What a click on another ticket did while the side agent was live: switched to it, or not.
export type SwitchResult = { kind: 'opened' | 'declined'; paneId?: string; waiting?: boolean }

// How long after a declined click a click on the same ticket switches anyway (D14).
const CONFIRM_MS = 15_000
// How long a herdr call may run, as herdr.ts gives its own.
const HERDR_MS = 10_000

// The last declined click: the ticket clicked, and when its toast was shown. A reload starts the
// module, and so this, over (K6): the next click on a busy agent toasts again.
let declined: { ticket: string; at: number } | undefined

// A click on `id` at `now` is the second one the toast asked for: the last decline was for `id`,
// at most 15 seconds before. A clock that went back since counts as no confirmation.
function isConfirmed(id: string, now: number): boolean {
  if (declined === undefined || declined.ticket !== id) return false
  const elapsed = now - declined.at
  return elapsed >= 0 && elapsed < CONFIRM_MS
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

// What herdr shows as pane `paneId`'s terminal id, or undefined when the look fails.
async function terminalOf($: EngineInterface, paneId: string): Promise<unknown> {
  try {
    const out = await $.process.run(['herdr', 'pane', 'get', paneId], { timeoutMs: HERDR_MS })
    if (out.exitCode !== 0) return undefined
    return field(field(field(JSON.parse(out.stdout), 'result'), 'pane'), 'terminal_id')
  } catch {
    return undefined // herdr is missing, ran past its time, or wrote no JSON
  }
}

// Closes the recorded activity pane while it is ours: herdr shows it with the terminal it had
// (E9). A look that fails counts as not ours, and a pane not ours is never closed. A close that
// fails is passed over: the switch goes on.
async function closeActivity($: EngineInterface, side: Side): Promise<void> {
  const { activityPaneId, activityTerminalId } = side
  if (activityPaneId === undefined || activityTerminalId === undefined) return
  if ((await terminalOf($, activityPaneId)) !== activityTerminalId) return
  try {
    await $.process.run(['herdr', 'pane', 'close', activityPaneId], { timeoutMs: HERDR_MS })
  } catch {
    // Nothing more to do.
  }
}

// E4: closes the activity pane, ends the side agent and closes its pane, then opens `id` in a fresh
// pane split right of the main one. The record goes before the launch, so a launch that fails
// (it throws a SidePaneError) leaves no record of the panes closed here.
async function switchTo($: EngineInterface, side: Side, id: string): Promise<SwitchResult> {
  declined = undefined
  await closeActivity($, side)
  await exitAgent($, side.agentName, side.paneId)
  await updateSide($, () => undefined)
  return { kind: 'opened', ...(await launch($, id)) }
}

// Decides a click on ticket `id` while `side`, the side-pane record as `readSide` gave it, shows
// another ticket with its agent live (D3). An idle agent (E6) is switched from at once. A busy
// one, or one whose status could not be read, is switched from only on the second click the toast
// asks for; otherwise nothing is closed or opened, and the click is remembered for 15 seconds.
export async function decideSwitch($: EngineInterface, side: Side, id: string): Promise<SwitchResult> {
  if (isIdle(await agentStatus($, side.agentName))) return switchTo($, side, id)
  const now = await $.clock.now()
  if (isConfirmed(id, now)) return switchTo($, side, id)
  declined = { ticket: id, at: now }
  notify($, `${side.ticketId} is still working; click again to switch anyway`)
  return { kind: 'declined' }
}

// What a reload does to the remembered click: forgotten. Tests call it to start their own copy of
// this module over.
export function forgetSwitch(): void {
  declined = undefined
}

// This module's hooks, registered by register.tsx. None: a click reaches decideSwitch through the
// side-pane route (route.ts).
export function registerSwitch(on: On): void {}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known, possibly inside a draw, so it may start timers but never write `$.state`.
export async function switchReady($: EngineInterface, known: Role): Promise<void> {}
