import type { EngineInterface, On, ProcessRunResult } from 'claude-code'

import { closePane, readSide, updateSide } from './herdr'
import type { Side, SideRecord } from './herdr'
import { notify } from './notify'
import type { Role } from './role'
import { unfinishedRunFor } from './runs'

// The run-activity pane below the side agent (D8): while a /run-tickets run is working on the
// ticket (R2), a pane split down from the side pane runs that run's report for the ticket,
// redrawn every 30 seconds (D14). The noun's open calls `syncActivity` once the side pane for
// the ticket is placed, inside its open lock (E10), so nothing else changes the side-pane record
// meanwhile.

// How long a herdr call may run, as herdr.ts gives its own.
const HERDR_MS = 10_000
// How often the activity pane's report is drawn again, in seconds (D14).
const WATCH_SECONDS = 30
// A word the shell reads as itself. A ticket id is one (the noun takes only these, E17); anything
// else is quoted before it goes into the watch's command line.
const PLAIN_WORD = /^[A-Za-z0-9._-]+$/

type Pane = { paneId: string; terminalId: string }

// ---------- herdr ----------
// herdr.ts keeps its runner to itself, so this file reads herdr's answers the same way: JSON on
// stdout (`{ result }`) when the call went through. A failure is only that here: the toast names
// the step that failed (D17), not what herdr said. Which panes are ours is herdr.ts's look alone
// (E9), through readSide, and every pane this file closes goes through herdr.ts's closePane.

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function text(value: unknown, key: string): string | undefined {
  const found = field(value, key)
  return typeof found === 'string' ? found : undefined
}

function parsed(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

// `herdr <args>`'s result when it went through; undefined when herdr refused it, could not start,
// or ran past its time.
async function herdr($: EngineInterface, args: readonly string[]): Promise<{ result: unknown } | undefined> {
  let out: ProcessRunResult
  try {
    out = await $.process.run(['herdr', ...args], { timeoutMs: HERDR_MS })
  } catch {
    return undefined
  }
  return out.exitCode === 0 ? { result: field(parsed(out.stdout), 'result') } : undefined
}

// A new pane below the side pane, starting in the session root, focus left where it was. Throws
// `pane split` when herdr split nothing or named no pane and terminal; a pane it named without its
// terminal is closed.
async function splitBelow($: EngineInterface, sidePaneId: string): Promise<Pane> {
  const cwd = await $.session.root()
  const split = await herdr($, ['pane', 'split', sidePaneId, '--direction', 'down', '--no-focus', '--cwd', cwd])
  const pane = field(split?.result, 'pane')
  const paneId = text(pane, 'pane_id')
  const terminalId = text(pane, 'terminal_id')
  if (paneId !== undefined && terminalId !== undefined) return { paneId, terminalId }
  if (paneId !== undefined) await closePane($, paneId)
  throw new Error('pane split')
}

// ---------- the watch ----------

// `word` as the shell reads it back: as it is when plain, else in single quotes, each `'` in it
// written `'\''`.
function shellWord(word: string): string {
  return PLAIN_WORD.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`
}

// The command the activity pane runs (1.2's `--ticket` and `--watch`). The run id goes in as it
// is: runs.ts answers only ids of the workflow's shape, which the shell reads as themselves.
function watchCommand(id: string, runId: string): string {
  return `run-tickets-status --ticket ${shellWord(id)} --watch ${WATCH_SECONDS} ${runId}`
}

// The record's side part: what stays when its activity pane goes.
function sidePart(side: SideRecord): SideRecord {
  return { ticketId: side.ticketId, paneId: side.paneId, paneTerminalId: side.paneTerminalId, agentName: side.agentName }
}

// Opens ticket `id`'s activity pane for run `runId` below the side pane, and records it. `pane run`
// only queues the command for the new pane's shell; a pane whose command herdr does not take, or
// that cannot be recorded, is closed again, and the failure goes on to the toast.
async function openBelow($: EngineInterface, side: Side, id: string, runId: string): Promise<void> {
  const pane = await splitBelow($, side.paneId)
  try {
    const ran = await herdr($, ['pane', 'run', pane.paneId, watchCommand(id, runId)])
    if (ran === undefined) throw new Error('pane run')
    const activity = { activityPaneId: pane.paneId, activityTerminalId: pane.terminalId, activityTicketId: id }
    await updateSide($, () => ({ ...sidePart(side), ...activity }))
  } catch (error) {
    await closePane($, pane.paneId)
    throw error
  }
}

// The steps of `syncActivity`; what fails throws, its message naming what failed.
async function sync($: EngineInterface, id: string): Promise<void> {
  // The lookup comes first, before herdr is asked anything: the noun's tests watch it to see this
  // run, and hold it open to test their lock.
  const run = await unfinishedRunFor($, id)
  if ('error' in run) throw new Error(run.error)
  // readSide gives the activity part only whole, and only while that pane is ours (E9): one whose
  // terminal no longer matches is dropped from the record there and never closed. A look herdr
  // does not answer throws (`pane get: <reason>`, `agent get: <reason>`) with the record kept, and
  // goes on to the toast.
  const side = await readSide($)
  if (side === undefined) return
  if ('runId' in run && side.activityTicketId === id) return
  if (side.activityPaneId !== undefined) {
    await closePane($, side.activityPaneId)
    await updateSide($, () => sidePart(side))
  }
  if ('runId' in run) await openBelow($, side, id, run.runId)
}

// What a failure says, on one line: the first line of its message.
function whatFailed(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().split('\n')[0] ?? ''
}

// Opens, keeps or closes the activity pane for ticket `id`, once its side pane is placed (D8):
// - In a running run (R2): an activity pane of ours for `id` is kept (the record names no run, so
//   by its ticket alone). Otherwise any activity pane of ours closes, the side pane is split down,
//   the new pane runs `run-tickets-status --ticket <id> --watch 30 <run id>`, and the record takes
//   its pane, terminal and ticket.
// - In none: any activity pane of ours closes and the record's activity fields are cleared.
// - When the lookup fails, nothing else is asked or changed. When the new pane can't be split or
//   given its command, no activity pane is recorded. Either way `no run activity for <id>: <what
//   failed>` is toasted (D17): the lookup's error, `pane split` or `pane run`.
// - With no side pane on record, or one no longer ours, there is nothing to open one below.
// It never throws, since the noun's open takes a throw as its side pane failing (D13): anything
// else that fails is toasted the same way, by its first line. The side pane is left as it is.
export async function syncActivity($: EngineInterface, id: string): Promise<void> {
  try {
    await sync($, id)
  } catch (error) {
    notify($, `no run activity for ${id}: ${whatFailed(error)}`)
  }
}

// This module's hooks, registered by register.tsx. None: the noun's open calls syncActivity.
export function registerActivity(on: On): void {}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known. It has nothing to start.
export async function activityReady($: EngineInterface, known: Role): Promise<void> {}
