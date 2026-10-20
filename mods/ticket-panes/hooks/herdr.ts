import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { notify } from './notify'
import { role } from './role'
import { recordedSession } from './sessions'
import { ticketsDir } from './tickets'

// herdr's side of a main session in herdr (R4): the side-pane record, and starting and ending the
// Claude agent in the side pane; and, for the side session itself, closing its panes as it ends
// (`closeOwnPanes`). It holds the mod's one herdr runner, `herdr`, and its answer
// readers `field` and `text`: route.ts, switch.ts and activity.ts call herdr through them too, so
// every file reads the same answer the same way. Every herdr call goes through `$.process.run`
// with a timeout of its own. herdr answers JSON on stdout (`{ result }`), and on failure exits 1
// with `{ error: { code, message } }` on stderr.

// How long a herdr call may run. `agent wait` waits up to 10 s of its own and `agent start` up to
// 30 s, so each gets more than that.
const HERDR_MS = 10_000
const WAIT_MS = 15_000
const START_MS = 45_000
// After `/exit`: how many times the pane's foreground is checked for `claude`, and the wait
// between two checks. Nine waits at most, so 4.5 s of the hook's own time (E5, K6).
const EXIT_CHECKS = 10
const EXIT_CHECK_GAP_MS = 500
// What `agent start` fails with when Claude starts on a question (folder trust, say).
const NOT_READY = 'agent_not_ready'
// The side pane's share of the main pane's width when it splits off. herdr's `pane split
// --ratio` is the share the pane being split keeps (checked live, herdr 0.9.4), so the split
// passes the rest.
const SIDE_PANE_SHARE = 0.3
const SPLIT_RATIO = String(1 - SIDE_PANE_SHARE)
// Each herdr call the side session makes as it ends. The whole `session.end` chain shares one
// short bound (1.5 s by default), and the side pane's own close comes last, so the calls before
// it must leave it room.
const END_MS = 400

// The side-pane record (E9), kept in `$.store` under `side:<the main session's pane>`: the side
// pane with the terminal it had when recorded, its agent's name and, while there is one, the
// run-activity pane below it with its terminal and the ticket it shows.
export type SideRecord = {
  ticketId: string
  paneId: string
  paneTerminalId: string
  agentName: string
  activityPaneId?: string
  activityTerminalId?: string
  activityTicketId?: string
}

// The record as `readSide` found it in herdr: the parts no longer ours dropped, and whether the
// side agent is live in its pane.
export type Side = SideRecord & { sideAgentLive: boolean }

// What `launch` placed: the side pane, and `waiting` when Claude started on a question there.
export type Launched = { paneId: string; waiting?: boolean }

// Opening the side pane failed at `step` (`pane split`, `agent start`, ...); the message names the
// step and what herdr said.
export class SidePaneError extends Error {
  readonly step: string

  constructor(step: string, reason: string) {
    super(`${step}: ${reason}`)
    this.name = 'SidePaneError'
    this.step = step
  }
}

type Pane = { paneId: string; terminalId: string }
type Activity = Required<Pick<SideRecord, 'activityPaneId' | 'activityTerminalId' | 'activityTicketId'>>
// Where a side pane splits from, the folder it starts in, and its `--env` arguments.
type Split = { from: string; cwd: string; env: string[] }
// A herdr call's answer: its result, or the code herdr gave (when it gave one) and why it failed.
// A failed call has no result, so a reader of one finds nothing there.
export type Ran = { isOk: true; result: unknown } | { isOk: false; result?: undefined; code?: string; reason: string }

const SIDE_FIELDS = ['ticketId', 'paneId', 'paneTerminalId', 'agentName'] as const
const ACTIVITY_FIELDS = ['activityPaneId', 'activityTerminalId', 'activityTicketId'] as const

// ---------- reading herdr's answers ----------

// `value[key]` when `value` is an object, else undefined.
export function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

// `value[key]` when it is a string, else undefined.
export function text(value: unknown, key: string): string | undefined {
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

function firstLine(output: string): string {
  return output.trim().split('\n')[0] ?? ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Runs `herdr <args>` with a timeout of `timeoutMs` (10 s unless given), and gives its answer.
export async function herdr($: EngineInterface, args: readonly string[], timeoutMs: number = HERDR_MS): Promise<Ran> {
  let out: ProcessRunResult
  try {
    out = await $.process.run(['herdr', ...args], { timeoutMs })
  } catch (error) {
    return { isOk: false, reason: messageOf(error) } // herdr is missing, or ran past its time
  }
  if (out.exitCode === 0) return { isOk: true, result: field(parsed(out.stdout), 'result') }
  // herdr's own error, or a usage line (exit status 2) when it could not read the command.
  const error = field(parsed(out.stderr), 'error')
  const reason = text(error, 'message') ?? (firstLine(out.stderr) || `exit status ${out.exitCode}`)
  return { isOk: false, code: text(error, 'code'), reason }
}

// Closes a pane as best it can: when the close fails (the pane is already gone, say) there is
// nothing more to do.
export async function closePane($: EngineInterface, paneId: string, timeoutMs: number = HERDR_MS): Promise<void> {
  await herdr($, ['pane', 'close', paneId], timeoutMs)
}

// What a look in herdr found: `yes`, `no`, or, when herdr gave no answer of its own (the call
// rejected or timed out, failed with another code, or printed no JSON naming what was asked), the
// SidePaneError that names the look's step and why.
export type Look = 'yes' | 'no' | SidePaneError

// A look's answer as `step` read it: what `shown` found against `expected`, or `no` when herdr
// failed with `notFound`, its own word that the thing is gone.
function lookOf(step: string, ran: Ran, notFound: string, shown: string | undefined, expected: string): Look {
  if (!ran.isOk) return ran.code === notFound ? 'no' : new SidePaneError(step, ran.reason)
  if (shown === undefined) return new SidePaneError(step, 'herdr gave no answer it could read')
  return shown === expected ? 'yes' : 'no'
}

// Whether a look found yes. Only herdr's own answers decide (E9): a look herdr did not answer
// throws its SidePaneError, so nothing is closed, focused or dropped on a guess.
export function isYes(look: Look): boolean {
  if (look instanceof SidePaneError) throw look
  return look === 'yes'
}

// A recorded pane is ours only while herdr shows it with the terminal it had (E9). It is not ours
// when herdr shows another terminal there or says `pane_not_found`.
export async function isOurs($: EngineInterface, paneId: string, terminalId: string, timeoutMs: number = HERDR_MS): Promise<Look> {
  const ran = await herdr($, ['pane', 'get', paneId], timeoutMs)
  return lookOf('pane get', ran, 'pane_not_found', text(field(ran.result, 'pane'), 'terminal_id'), terminalId)
}

// The agent is live in the pane only while herdr shows it there. It is not when herdr shows it in
// another pane or says `agent_not_found`.
async function isAgentIn($: EngineInterface, name: string, paneId: string): Promise<Look> {
  const ran = await herdr($, ['agent', 'get', name])
  return lookOf('agent get', ran, 'agent_not_found', text(field(ran.result, 'agent'), 'pane_id'), paneId)
}

// ---------- the record ----------

// The main session's own pane (R4): side panes split from it, and the record is kept under it.
async function mainPane($: EngineInterface): Promise<string> {
  const { herdrPaneId } = await role($)
  if (herdrPaneId === undefined) throw new SidePaneError('herdr pane', 'this session is not in a herdr pane')
  return herdrPaneId
}

async function sideKey($: EngineInterface): Promise<string> {
  return `side:${await mainPane($)}`
}

// `fields` of `value` when every one of them is a string, else undefined.
function picked(value: unknown, fields: readonly string[]): Record<string, string> | undefined {
  const found: Record<string, string> = {}
  for (const key of fields) {
    const got = text(value, key)
    if (got === undefined) return undefined
    found[key] = got
  }
  return found
}

function activityOf(value: unknown): Activity | undefined {
  return picked(value, ACTIVITY_FIELDS) as Activity | undefined
}

// The record in `value` with only its own fields, or undefined when its side part is not whole.
// The activity part is kept only whole.
function recordOf(value: unknown): SideRecord | undefined {
  const side = picked(value, SIDE_FIELDS) as SideRecord | undefined
  return side === undefined ? undefined : { ...side, ...activityOf(value) }
}

// The record without its activity part: what stays when its activity pane goes.
export function sidePart(record: SideRecord): SideRecord {
  const { ticketId, paneId, paneTerminalId, agentName } = record
  return { ticketId, paneId, paneTerminalId, agentName }
}

// The side-pane record with each pane checked in herdr (E9), or undefined when there is none or its
// side pane is no longer ours. A pane that is not ours is dropped from the record and never closed;
// but when the side pane goes, the activity pane below it is closed while it is still ours.
// `sideAgentLive` is true only when herdr also finds the agent in the side pane. A look herdr does
// not answer (`pane get` or `agent get`) throws its SidePaneError before the record is written or
// any pane closed, so a herdr hiccup loses nothing.
export async function readSide($: EngineInterface): Promise<Side | undefined> {
  const key = await sideKey($)
  const record = recordOf(await $.store.get(key))
  if (record === undefined) return undefined
  const isSideOurs = isYes(await isOurs($, record.paneId, record.paneTerminalId))
  const activity = activityOf(record)
  const ourActivity =
    activity !== undefined && isYes(await isOurs($, activity.activityPaneId, activity.activityTerminalId)) ? activity : undefined
  if (!isSideOurs) {
    if (ourActivity !== undefined) await closePane($, ourActivity.activityPaneId)
    await $.store.delete(key)
    return undefined
  }
  const sideAgentLive = isYes(await isAgentIn($, record.agentName, record.paneId))
  let kept = record
  if (activity !== undefined && ourActivity === undefined) {
    kept = sidePart(record)
    await $.store.set(key, kept)
  }
  return { ...kept, sideAgentLive }
}

// Writes the side-pane record that `change` makes of the stored one (undefined when there is
// none), keeping only the record's own fields; undefined, or a record whose side part is not
// whole, removes it. Resolves what was written.
export async function updateSide(
  $: EngineInterface,
  change: (side: SideRecord | undefined) => SideRecord | undefined,
): Promise<SideRecord | undefined> {
  const key = await sideKey($)
  const next = recordOf(change(recordOf(await $.store.get(key))))
  if (next === undefined) await $.store.delete(key)
  else await $.store.set(key, next)
  return next
}

// ---------- names ----------

// E3: `tp-` and the ticket id, lowercased, anything outside `[a-z0-9_-]` made `-`, cut to 32
// characters, which keeps it a herdr agent name (`[a-z][a-z0-9_-]{0,31}`).
export function agentName(id: string): string {
  return `tp-${id}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, 32)
}

// ---------- launching ----------

// E7: a new session id from uuidgen, lowercased as Claude Code writes its own.
async function newSessionId($: EngineInterface): Promise<string> {
  let out: ProcessRunResult
  try {
    out = await $.process.run(['/usr/bin/uuidgen'], { timeoutMs: HERDR_MS })
  } catch (error) {
    throw new SidePaneError('uuidgen', messageOf(error))
  }
  if (out.exitCode !== 0) throw new SidePaneError('uuidgen', firstLine(out.stderr) || `exit status ${out.exitCode}`)
  return out.stdout.trim().toLowerCase()
}

async function isFolder($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'dir'
  } catch {
    return false
  }
}

// E8: what the side pane's shell, and so its Claude, starts with. An empty value counts as unset.
// TICKET_PANES_CWD is the folder the pane starts in: the root of the pane's own Claude. role.ts
// (R4) uses it, with whether a session draws anywhere, to tell that Claude apart from any `claude`
// a hook or tool starts from the pane, which inherits these variables.
async function paneEnv($: EngineInterface, id: string, dir: string, cwd: string): Promise<string[]> {
  const env = ['--env', `TICKET_PANES_TICKET=${id}`, '--env', `TICKETS_DIR=${dir}`, '--env', `TICKET_PANES_CWD=${cwd}`]
  const pluginDirs = await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')
  if (pluginDirs) env.push('--env', `CLAUDE_CODE_PLUGIN_DIRS=${pluginDirs}`)
  return env
}

// A new pane right of the main one, SIDE_PANE_SHARE of its width, focus left where it was.
async function splitPane($: EngineInterface, split: Split): Promise<Pane> {
  const args = ['pane', 'split', split.from, '--direction', 'right', '--ratio', SPLIT_RATIO, '--no-focus', '--cwd', split.cwd]
  const ran = await herdr($, [...args, ...split.env])
  if (!ran.isOk) throw new SidePaneError('pane split', ran.reason)
  const pane = field(ran.result, 'pane')
  const paneId = text(pane, 'pane_id')
  const terminalId = text(pane, 'terminal_id')
  if (paneId !== undefined && terminalId !== undefined) return { paneId, terminalId }
  if (paneId !== undefined) await closePane($, paneId)
  throw new SidePaneError('pane split', 'herdr named no pane and terminal')
}

// Starts Claude in the pane under `name`; `args` are Claude's own (`agent start` has no `--cwd`).
async function startAgent($: EngineInterface, name: string, paneId: string, args: readonly string[]): Promise<Ran> {
  return herdr($, ['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', '30000', '--', ...args], START_MS)
}

// Records `pane` as ticket `id`'s side pane. A new pane has no activity pane below it yet, so any
// activity part stored before goes.
async function keepRecord($: EngineInterface, id: string, pane: Pane, name: string): Promise<void> {
  await updateSide($, () => ({ ticketId: id, paneId: pane.paneId, paneTerminalId: pane.terminalId, agentName: name }))
}

// The answer for a start that went through: at once, or waiting on the question Claude started on
// (D15).
function placed($: EngineInterface, id: string, pane: Pane, started: Ran): Launched {
  if (started.isOk) return { paneId: pane.paneId }
  notify($, `${id} needs an answer in the side pane`)
  return { paneId: pane.paneId, waiting: true }
}

// Before the E13 retry closes a side pane: the recorded activity pane closes first while it is
// still ours, and the record goes, since neither pane stays. A look herdr does not answer leaves
// the activity pane open, as one not ours: the side pane above it is closing anyway.
async function dropRecord($: EngineInterface): Promise<void> {
  const key = await sideKey($)
  const activity = activityOf(recordOf(await $.store.get(key)))
  if (activity !== undefined && (await isOurs($, activity.activityPaneId, activity.activityTerminalId)) === 'yes') {
    await closePane($, activity.activityPaneId)
  }
  await $.store.delete(key)
}

// E13: the recorded conversation did not start. Its pane closes and a fresh one starts a new
// conversation (D18).
async function startOver($: EngineInterface, id: string, split: Split, name: string, failed: Pane): Promise<Launched> {
  await dropRecord($)
  await closePane($, failed.paneId)
  const sessionId = await newSessionId($)
  const pane = await splitPane($, split)
  const started = await startAgent($, name, pane.paneId, ['--session-id', sessionId, '-n', `ticket ${id}`])
  if (!started.isOk && started.code !== NOT_READY) {
    await closePane($, pane.paneId)
    throw new SidePaneError('agent start', started.reason)
  }
  notify($, `${id}: earlier conversation not found; started a new one`)
  await keepRecord($, id, pane, name)
  return placed($, id, pane, started)
}

// Opens ticket `id`'s side agent (E7, E8, E13) in a new pane split right of the main session's.
// It resumes the conversation R3 recorded for the ticket, the split starting in its recorded
// folder when that is still there (else the session root), or starts a new one, and records the
// pane (E9). It never writes R3.
// - `agent_not_ready` (Claude started on a question): the pane stays and is recorded, and the
//   person is told it needs an answer (D15); resolves with `waiting`.
// - Any other failure of a resume: E13, a new conversation in a fresh pane.
// - Any other failure: the pane this call split is closed, nothing is recorded, and it throws a
//   SidePaneError naming the step.
export async function launch($: EngineInterface, id: string): Promise<Launched> {
  const from = await mainPane($)
  const dir = await ticketsDir($)
  if (dir === undefined) throw new SidePaneError('tickets dir', 'no tickets dir for this session')
  const recorded = await recordedSession($, dir, id)
  const cwd = recorded !== undefined && (await isFolder($, recorded.cwd)) ? recorded.cwd : await $.session.root()
  const split: Split = { from, cwd, env: await paneEnv($, id, dir, cwd) }
  const name = agentName(id)
  // A new session id comes before the split, so a uuidgen failure leaves nothing to close.
  const session = recorded === undefined ? ['--session-id', await newSessionId($)] : ['--resume', recorded.sessionId]
  const pane = await splitPane($, split)
  const started = await startAgent($, name, pane.paneId, [...session, '-n', `ticket ${id}`])
  if (started.isOk || started.code === NOT_READY) {
    await keepRecord($, id, pane, name)
    return placed($, id, pane, started)
  }
  if (recorded !== undefined) return startOver($, id, split, name, pane)
  await closePane($, pane.paneId)
  throw new SidePaneError('agent start', started.reason)
}

// ---------- exiting ----------

// The agent's herdr status (`idle`, `done`, `working`, `blocked` or `unknown`), or undefined when
// herdr finds no agent of that name.
export async function agentStatus($: EngineInterface, name: string): Promise<string | undefined> {
  const ran = await herdr($, ['agent', 'get', name])
  return text(field(ran.result, 'agent'), 'agent_status')
}

// E6: `idle` and `done` are idle; anything else, a status that could not be read included, is
// busy.
export function isIdle(status: string | undefined): boolean {
  return status === 'idle' || status === 'done'
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

// A foreground process is Claude by the name it was started as: the native install runs as a file
// named for its version, and an npm install as the script node runs.
function isClaude(entry: unknown): boolean {
  const argv = field(entry, 'argv')
  const names = [field(entry, 'name'), field(entry, 'argv0'), ...(Array.isArray(argv) ? argv.slice(0, 2) : [])]
  return names.some(name => typeof name === 'string' && baseName(name) === 'claude')
}

async function isClaudeIn($: EngineInterface, paneId: string): Promise<boolean> {
  const ran = await herdr($, ['pane', 'process-info', '--pane', paneId])
  const processes = field(field(ran.result, 'process_info'), 'foreground_processes')
  return Array.isArray(processes) && processes.some(isClaude)
}

// Waits for `claude` to leave the pane's foreground: up to 10 checks, 500 ms apart. A check that
// fails ends the wait.
async function waitForExit($: EngineInterface, paneId: string): Promise<void> {
  for (let check = 1; await isClaudeIn($, paneId); check++) {
    if (check === EXIT_CHECKS) return
    await $.clock.sleep(EXIT_CHECK_GAP_MS)
  }
}

// E5: ends agent `name` and closes its pane. A busy agent is interrupted and waited for first;
// then `ctrl+c` clears what was typed, `/exit` ends Claude, and the pane closes once `claude` has
// left its foreground, or after the last check. A step that fails is passed over: the pane closes
// either way.
export async function exitAgent($: EngineInterface, name: string, paneId: string): Promise<void> {
  if (!isIdle(await agentStatus($, name))) {
    await herdr($, ['agent', 'send-keys', name, 'esc'])
    await herdr($, ['agent', 'wait', name, '--until', 'idle', '--until', 'done', '--timeout', '10000'], WAIT_MS)
  }
  await herdr($, ['agent', 'send-keys', name, 'ctrl+c'])
  await herdr($, ['agent', 'prompt', name, '/exit'])
  await waitForExit($, paneId)
  await closePane($, paneId)
}

// The activity part of the record whose side pane is `paneId`, or undefined when no record names
// it or its activity part is not whole. The side session does not know the main session's pane the
// record is kept under, so it looks through every `side:` record. herdr never gives a closed
// pane's id again, so a record a later launch wrote never names this pane.
async function activityOver($: EngineInterface, paneId: string): Promise<Activity | undefined> {
  for (const key of await $.store.keys()) {
    if (!key.startsWith('side:')) continue
    const record = recordOf(await $.store.get(key))
    if (record?.paneId === paneId) return activityOf(record)
  }
  return undefined
}

// The side session's own panes as the person leaves its Claude (`/exit`, ctrl+c, ctrl+d): the
// run-activity pane below it, while that is ours (E9), then `paneId`, the side session's own pane,
// which ends the process this runs in, so it goes last. The record is only read: the main session
// may be writing it (a switch), and its next `readSide` drops a record whose side pane is gone. It
// never throws: a store that cannot be read leaves the activity pane to that `readSide`, and a
// close of a pane already gone (a switch's `exitAgent` got there first) or a look herdr does not
// answer is passed over, so the side pane still closes.
export async function closeOwnPanes($: EngineInterface, paneId: string): Promise<void> {
  try {
    const activity = await activityOver($, paneId)
    if (activity !== undefined && (await isOurs($, activity.activityPaneId, activity.activityTerminalId, END_MS)) === 'yes') {
      await closePane($, activity.activityPaneId, END_MS)
    }
  } catch {
    // The store could not be read: the activity pane stays for the main session's readSide.
  }
  await closePane($, paneId, END_MS)
}
