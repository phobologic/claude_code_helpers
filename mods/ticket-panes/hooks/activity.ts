import type { EngineInterface, On } from 'claude-code'

import { closePane, field, herdr, readSide, sidePart, text, updateSide } from './herdr'
import type { Side } from './herdr'
import { notify } from './notify'
import type { Role } from './role'
import { unfinishedRunFor } from './runs'

// The run-activity pane below the side agent (D8): while a /run-tickets run is working on the
// ticket (R2), a pane split down from the side pane runs that run's report for the ticket,
// redrawn every 30 seconds (D14). The noun's open calls `syncActivity` once the side pane for
// the ticket is placed, inside its open lock (E10), so nothing else changes the side-pane record
// meanwhile.

// How often the activity pane's report is drawn again, in seconds (D14).
const WATCH_SECONDS = 30
// A word the shell reads as itself. A ticket id is one (the noun takes only these, E17); anything
// else is quoted before it goes into the watch's command line.
const PLAIN_WORD = /^[A-Za-z0-9._-]+$/

type Pane = { paneId: string; terminalId: string }

// ---------- herdr ----------
// Each call goes through herdr.ts's runner, with its default timeout of 10 s. A failure is only
// that here: the toast names the step that failed (D17), not what herdr said. Which panes are ours
// is herdr.ts's look alone (E9), through readSide, and every pane this file closes goes through
// herdr.ts's closePane.

// A new pane below the side pane, starting in the session root, focus left where it was. Throws
// `pane split` when herdr split nothing or named no pane and terminal; a pane it named without its
// terminal is closed.
async function splitBelow($: EngineInterface, sidePaneId: string): Promise<Pane> {
  const cwd = await $.session.root()
  const split = await herdr($, ['pane', 'split', sidePaneId, '--direction', 'down', '--no-focus', '--cwd', cwd])
  const pane = field(split.result, 'pane')
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

// The watch's arguments (1.2's `--ticket` and `--watch`), as its process gets them.
function watchArgs(id: string, runId: string): string[] {
  return ['--ticket', id, '--watch', String(WATCH_SECONDS), runId]
}

// The command the activity pane runs: its arguments as the shell reads them back. runs.ts answers
// only run ids of the workflow's shape, which go in as they are.
function watchCommand(id: string, runId: string): string {
  return ['run-tickets-status', ...watchArgs(id, runId).map(shellWord)].join(' ')
}

// Whether `argv` holds `words` one after another.
function holdsInOrder(argv: readonly unknown[], words: readonly string[]): boolean {
  for (let start = 0; start + words.length <= argv.length; start++) {
    if (words.every((word, at) => argv[start + at] === word)) return true
  }
  return false
}

// Whether the pane's foreground is still this watch, by `pane process-info`. herdr gives each
// foreground process's `argv` as the kernel started it: run-tickets-status starts through its
// shebang, so its argv is the interpreter, the script's path, then the watch's arguments. A look
// that fails, or a foreground without them (the watch was stopped and the shell is back, or it
// watches another run), is not this watch.
async function isWatching($: EngineInterface, paneId: string, id: string, runId: string): Promise<boolean> {
  const ran = await herdr($, ['pane', 'process-info', '--pane', paneId])
  const processes = field(field(ran?.result, 'process_info'), 'foreground_processes')
  if (!Array.isArray(processes)) return false
  const words = watchArgs(id, runId)
  return processes.some(entry => {
    const argv = field(entry, 'argv')
    return Array.isArray(argv) && holdsInOrder(argv, words)
  })
}

// Opens ticket `id`'s activity pane for run `runId` below the side pane, and records it. `pane run`
// only queues the command for the new pane's shell; a pane whose command herdr does not take, or
// that cannot be recorded, is closed again, and the failure goes on to the toast.
async function openBelow($: EngineInterface, side: Side, id: string, runId: string): Promise<void> {
  const pane = await splitBelow($, side.paneId)
  try {
    const ran = await herdr($, ['pane', 'run', pane.paneId, watchCommand(id, runId)])
    if (!ran.isOk) throw new Error('pane run')
    const activity = { activityPaneId: pane.paneId, activityTerminalId: pane.terminalId, activityTicketId: id }
    await updateSide($, () => ({ ...sidePart(side), ...activity }))
  } catch (error) {
    await closePane($, pane.paneId)
    throw error
  }
}

// Whether the record's activity pane stays as it is: it shows ticket `id` and its foreground is
// still the watch of run `runId`. Another ticket's pane is not looked at.
async function isKept($: EngineInterface, side: Side, id: string, runId: string): Promise<boolean> {
  if (side.activityPaneId === undefined || side.activityTicketId !== id) return false
  return isWatching($, side.activityPaneId, id, runId)
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
  if ('runId' in run && (await isKept($, side, id, run.runId))) return
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
// - In a running run (R2): an activity pane of ours for `id` is kept while `pane process-info`
//   shows it still running the watch of the run the lookup names now. Otherwise (another ticket,
//   another run after a resume, a watch that was stopped, a look that failed) any activity pane of
//   ours closes, the side pane is split down, the new pane runs
//   `run-tickets-status --ticket <id> --watch 30 <run id>`, and the record takes its pane,
//   terminal and ticket.
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
