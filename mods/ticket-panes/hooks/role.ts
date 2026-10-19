import type { EngineInterface, PromptSubmitInput } from 'claude-code'

import type { TicketPanesRole } from '../types'
import { runReady } from './register'

// The session's role (R4, E15) and what counts as a prompt the person typed (R5).

export type Role = TicketPanesRole

// The mod's four `$.state` values, as typed references: for tests (their `state.get` and
// `state.set` hooks), and as the one list of them besides the contract. Plugin code never hands
// these to `$.state`, `read` or `update`. The engine's scan takes a reference there only as a
// literal or a const of the calling file, and it refuses a module whose const is both exported
// and the reference of such a call. So each file that reads or writes a value writes its own
// const, and `claude plugin validate` checks its key against the contract.
export const roleRef = { plugin: 'ticket-panes', key: 'role' } as const
export const paneTicketRef = { plugin: 'ticket-panes', key: 'paneTicket' } as const
export const bandModeRef = { plugin: 'ticket-panes', key: 'bandMode' } as const
export const ticketVersionRef = { plugin: 'ticket-panes', key: 'ticketVersion' } as const

// This file's own reference to the stored role.
const ROLE = { plugin: 'ticket-panes', key: 'role' } as const

// The role once this load has resolved it; a reload starts the module, and so this, over (K6).
let known: Role | undefined
// The resolution in flight, which a call made meanwhile waits for.
let resolving: Promise<Role | undefined> | undefined

// R4, from the variables the session was started with. An empty value counts as unset, as tk
// treats its own; `herdrPaneId` is set only in herdr (`HERDR_ENV` is `1` and a pane id is set).
// `ticket` is TICKET_PANES_TICKET once `isPaneClaude` has said the session is the pane's own.
export function roleFrom(ticket: string | undefined, herdrEnv: string | undefined, herdrPaneId: string | undefined): Role {
  const found: Role = ticket ? { kind: 'side', sideTicket: ticket } : { kind: 'main' }
  if (herdrEnv === '1' && herdrPaneId) found.herdrPaneId = herdrPaneId
  return found
}

// R4: whether a session with TICKET_PANES_TICKET set is the side pane's own Claude. The launcher
// (herdr.ts) names the folder it starts the pane in as TICKET_PANES_CWD, and the pane's Claude
// has that folder as its root, after `/clear` and an in-pane `/resume` too. Every process the
// pane's Claude starts inherits the variables, Claude Code's session-title run among them (a
// `claude -p` in the temp folder), and none of those may act as the side session: above all, none
// may record itself as the ticket's conversation (R3). So a session is not the pane's own when the
// launcher named a folder and the session's root is known to be another. A launch folder unset or
// empty (a pane started before the launcher named one) leaves R4 as it was. A root that cannot be
// read leaves the session side, so the guard still holds; R3 cannot be written without the root.
export function isPaneClaude(launchFolder: string | undefined, root: string | undefined): boolean {
  return !launchFolder || root === undefined || root === launchFolder
}

function sameRole(a: Role, b: Role | undefined): boolean {
  return b !== undefined && a.kind === b.kind && a.sideTicket === b.sideTicket && a.herdrPaneId === b.herdrPaneId
}

// The session's root, or undefined when it cannot be read here.
async function rootOf($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.session.root()
  } catch {
    return undefined
  }
}

// The role the environment gives, or undefined when it cannot be read here.
async function envRole($: EngineInterface): Promise<Role | undefined> {
  try {
    const ticket = await $.env.get('TICKET_PANES_TICKET')
    const herdrEnv = await $.env.get('HERDR_ENV')
    const herdrPaneId = await $.env.get('HERDR_PANE_ID')
    const launchFolder = await $.env.get('TICKET_PANES_CWD')
    const root = await rootOf($)
    return roleFrom(isPaneClaude(launchFolder, root) ? ticket : undefined, herdrEnv, herdrPaneId)
  } catch {
    return undefined
  }
}

// The role stored in `$.state`, which survives a reload, or undefined when none is.
async function storedRole($: EngineInterface): Promise<Role | undefined> {
  try {
    const { value } = await $.state.get(ROLE)
    return value ?? undefined
  } catch {
    return undefined
  }
}

// R4 without the cache: the role the environment gives, stored in `$.state` when it differs from
// the stored one; the stored one when the environment cannot be read; undefined when neither can
// say. The engine refuses `$.state.set` while a `ui.render` hook draws, which leaves the stored
// role as it was: harmless, since it is only a fallback.
export async function resolveRole($: EngineInterface): Promise<Role | undefined> {
  const fromEnv = await envRole($)
  const stored = await storedRole($)
  if (fromEnv === undefined) return stored
  if (!sameRole(fromEnv, stored)) {
    try {
      await $.state.set(ROLE, fromEnv)
    } catch {
      // Refused (a draw is in progress): the role still stands.
    }
  }
  return fromEnv
}

async function settle($: EngineInterface): Promise<Role | undefined> {
  try {
    const found = await resolveRole($)
    if (found !== undefined) {
      known = found
      await runReady($, found)
    }
    return found
  } finally {
    resolving = undefined
  }
}

// R4 (E15): the role this load resolved; else resolves it now. Any event may be the first to ask,
// a draw included (`session.start` asks first in a new session; after a reload, whichever event
// needs the role first). The first resolution of a load runs every module's ready step once
// (register.tsx's `runReady`). While neither the environment nor `$.state` can say, it answers
// main and tries again on the next call. It never throws.
export async function role($: EngineInterface): Promise<Role> {
  if (known !== undefined) return known
  resolving ??= settle($)
  return (await resolving) ?? { kind: 'main' }
}

// The role this load has resolved, without resolving it: undefined until then. For a caller that
// cannot wait, such as a guard's `.catch` handler.
export function knownRole(): Role | undefined {
  return known
}

// What a reload does to the role: forgotten, so the next `role($)` resolves it and runs the ready
// steps again. Tests call it to start their own copy of this module over.
export function forgetRole(): void {
  known = undefined
  resolving = undefined
}

// R5 (E12): a counted prompt is a submission that runs no slash command and that the person saw
// as typed.
export function isCountedPrompt(e: Pick<PromptSubmitInput, 'command' | 'isMeta'>): boolean {
  return !e.command && !e.isMeta
}
