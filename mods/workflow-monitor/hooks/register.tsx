import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { AgentRow, RunSummary, TicketRow, Visibility } from '../types'

// A band above the prompt with two parts:
// - a /run-tickets run of the session's repo, from `run-tickets-status --json`: the newest
//   one this session launched, else the repo's newest; its progress and every ticket not
//   merged yet, with when its current step started;
// - the agents a workflow script started in this session: how many ran, and each one
//   still running with its start time and how long it has run, unless a ticket row above
//   already shows that agent.
// It takes rows from the transcript, so finished agents are a count, not a list; a tree
// taller than the band's room scrolls. It draws above whatever the hooks beneath it draw
// there (another mod's band), never in place of it.
// While the ticket-panes mod is loaded, each unmerged ticket's id is a button that opens
// the ticket through `$.ticketPanes.open`. workflow-monitor does not depend on that mod:
// it asks whether it is there and draws plain rows when it is not.
// Hooks modules have no Date, so clock times come from the UTC offset `date +%z` gives:
// read at session start, and by the next poll whenever it is unread (a /clear, which
// raises no session start, or a `date` that failed). Until then times show in UTC.

const TICK_MS = 15_000 // redraws running times
const BUSY_POLL_TICKS = 2 // read the run's status every 30s while something runs
const IDLE_POLL_TICKS = 20 // and every 5 minutes otherwise; a session that launched no run notices one started elsewhere
const VISIBLE_MS = 60_000 // only while the band has drawn within this long
const KEEP_AGENTS = 300

const agents = atom({ plugin: 'workflow-monitor', key: 'agents' } as const, [])
const run = atom({ plugin: 'workflow-monitor', key: 'run' } as const, null)
const tick = atom({ plugin: 'workflow-monitor', key: 'tick' } as const, 0)
// null until `date +%z` answered: 0 is a real offset, `+0000`.
const offset = atom({ plugin: 'workflow-monitor', key: 'utcOffsetMinutes' } as const, null as number | null)
const visibility = atom({ plugin: 'workflow-monitor', key: 'visibility' } as const, 'unset' as Visibility)

// Module state: it starts over on a reload, which costs at most one extra poll.
let lastDrawnAt = 0
let polling = false
// Whether ticket-panes answered `$.ticketPanes.available({})` since this module loaded;
// undefined until asked. Not `$.state`: a draw can't write state, and a reload starts this
// over exactly when it is worth asking again.
let canOpenTickets: boolean | undefined

// ---------- ticket-panes ----------

// Asked at session start, and by the first draw after a reload.
async function probeTicketPanes($: EngineInterface): Promise<boolean> {
  try {
    await $.ticketPanes.available({})
    canOpenTickets = true
  } catch {
    // Not loaded (`$.ticketPanes` is missing), or it failed: the ticket rows stay text.
    canOpenTickets = false
  }
  return canOpenTickets
}

async function openTicket($: EngineInterface, id: string): Promise<void> {
  try {
    await $.ticketPanes.open({ id })
  } catch {
    // ticket-panes tells the person about its own failures. What reaches here (the mod
    // went away since the probe, say) leaves the press doing nothing.
  }
}

// ---------- formatting ----------

const OFFSET = /^([+-])(\d\d)(\d\d)/

export function parseOffset(text: string): number {
  const m = OFFSET.exec(text.trim())
  if (!m) return 0
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -minutes : minutes
}

// Local HH:MM of a time in ms since the epoch.
export function clock(ms: number, offsetMinutes: number): string {
  const minutes = (((Math.floor(ms / 60_000) + offsetMinutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

// "45s", "2m28s" under ten minutes (as /workflows shows it), then "18m", "1h05m".
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// Stores the UTC offset `date +%z` gives. A `date` that fails (it prints no offset) or
// answers something else leaves the stored value as it was, so an unread offset stays
// unread for the next poll.
async function readOffset($: EngineInterface): Promise<void> {
  try {
    const out = await $.process.run(['/bin/date', '+%z'])
    if (!OFFSET.test(out.stdout.trim())) return
    const minutes = parseOffset(out.stdout)
    await update($, offset, () => minutes)
  } catch {
    // Times show in UTC until a later read works.
  }
}

// ---------- the run's status ----------

type ReportStep = { step: string; round: number; started?: string | null }
type ReportTicket = {
  id: string
  status: string
  outcome: string | null
  steps?: ReportStep[]
  timing?: { running_for?: number | null } | null
}
export type Report = {
  run_id: string
  state: string
  integration_branch?: string | null
  duration_seconds?: number | null
  merge_halted?: string | null
  tickets: ReportTicket[]
}

const STEP = { impl: 'impl', ac: 'AC', review: 'review', merge: 'merge' } as Record<string, string>

export function summarize(report: Report, checkedAt: number): RunSummary {
  const open: TicketRow[] = report.tickets
    .filter(t => t.outcome !== 'merged')
    .map(t => {
      const last = t.steps?.[t.steps.length - 1]
      const runningFor = t.timing?.running_for
      const row: TicketRow = { id: t.id, status: t.status, isActive: typeof runningFor === 'number' }
      if (last) row.step = `${STEP[last.step] ?? last.step}${last.round > 1 ? ` r${last.round}` : ''}`
      // The script writes local ISO times, so the clock time is the text itself.
      if (last?.started) row.startedClock = last.started.slice(11, 16)
      if (typeof runningFor === 'number') row.runningFor = runningFor
      return row
    })
  return {
    runId: report.run_id,
    state: report.state,
    branch: report.integration_branch ?? '',
    durationSeconds: report.duration_seconds ?? 0,
    merged: report.tickets.filter(t => t.outcome === 'merged').length,
    total: report.tickets.length,
    mergeHalted: report.merge_halted ?? '',
    open,
    checkedAt,
  }
}

function status($: EngineInterface, args: string[]) {
  return $.process.run(['run-tickets-status', ...args], { timeoutMs: 60_000 })
}

// The runs this session's workflow agents belong to, newest first. An agent whose workflow
// gave no run id names no run: `--json ''` would read the repo's newest.
export function sessionRuns(list: readonly AgentRow[]): string[] {
  const ids: string[] = []
  for (const a of [...list].reverse()) if (a.runId && !ids.includes(a.runId)) ids.push(a.runId)
  return ids
}

// The newest of the session's runs that `--list` names (a run-tickets run of this repo,
// not some other workflow's), or undefined when none is or it can't be read.
async function ownRun($: EngineInterface, mine: readonly string[]): Promise<Report | undefined> {
  const listed = await status($, ['--list'])
  if (listed.exitCode !== 0) return undefined
  const ids = new Set(listed.stdout.split('\n').map(line => line.trim().split(/\s+/)[0]))
  const id = mine.find(r => ids.has(r))
  if (id === undefined) return undefined
  const out = await status($, ['--json', id])
  return out.exitCode === 0 ? (JSON.parse(out.stdout) as Report) : undefined
}

// The run to show: the newest run this session launched, so another session's run
// started later in the same repo never takes the band; else the repo's newest run.
// null when the repo has no run.
async function readReport($: EngineInterface): Promise<Report | null> {
  const out = await status($, ['--json'])
  if (out.exitCode !== 0) return null // no run in this repo, or not a repo at all
  const newest = JSON.parse(out.stdout) as Report
  const mine = sessionRuns(await read($, agents))
  if (!mine.length || mine.includes(newest.run_id)) return newest
  return (await ownRun($, mine)) ?? newest
}

async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    // A draw can't write state, so an offset still unread is read here, once a poll.
    if ((await read($, offset)) === null) await readOffset($)
    const report = await readReport($)
    const checkedAt = await $.clock.now()
    const summary = report && summarize(report, checkedAt)
    await update($, run, () => summary)
  } catch {
    // Not installed, too slow this time, or output it could not read: keep the last summary.
  } finally {
    polling = false
  }
}

// ---------- drawing ----------

type Line = { text: string; isDim?: boolean }

// An unmerged ticket's line in two parts, its id and the rest after it, so the text and
// the band's row with a button for the id share one formatter. The caller pads the id to
// the widest one (`idWidth`), so the statuses line up.
export type TicketLine = { id: string; rest: string; isDim: boolean }

// How far a running run has moved on since its status was read, in seconds.
function sinceRead(summary: RunSummary, now: number): number {
  return summary.state === 'running' ? (now - summary.checkedAt) / 1000 : 0
}

// The run's progress, and why its merges stopped if they did.
function runHeader(summary: RunSummary, since: number): Line[] {
  const lines: Line[] = [{
    text: `run-tickets ${summary.runId}  ${summary.state} ${duration(summary.durationSeconds + since)}  `
      + `merged ${summary.merged}/${summary.total}  ${summary.branch}`,
  }]
  if (summary.mergeHalted) lines.push({ text: `  MERGES HALTED: ${summary.mergeHalted}` })
  return lines
}

export function ticketLine(row: TicketRow, since: number): TicketLine {
  const when = row.isActive && row.startedClock
    ? `  started ${row.startedClock}  running ${duration((row.runningFor ?? 0) + since)}`
    : ''
  return { id: row.id, rest: `  ${row.status}${when}`, isDim: !row.isActive }
}

function idWidth(open: readonly TicketRow[]): number {
  return Math.max(0, ...open.map(t => t.id.length))
}

export function runLines(summary: RunSummary, now: number): Line[] {
  const since = sinceRead(summary, now)
  const width = idWidth(summary.open)
  return [
    ...runHeader(summary, since),
    ...summary.open.map(t => {
      const line = ticketLine(t, since)
      return { text: `  ${line.id.padEnd(width)}${line.rest}`, isDim: line.isDim }
    }),
  ]
}

// A count of the session's workflow agents, then each one still running, newest first.
// An agent labelled for a ticket in `covered` (a ticket row already shows it) is only
// counted, so the list is left with agents no ticket row shows, like the final
// integration check.
export function agentLines(
  list: readonly AgentRow[], now: number, offsetMinutes: number, covered: ReadonlySet<string> = new Set(),
): Line[] {
  const running = list.filter(a => a.endedAt === undefined).reverse()
  const listed = running.filter(a => !a.label.split(' ').some(word => covered.has(word)))
  const finished = list.length - running.length
  const stopped = list.filter(a => a.isAborted).length
  const lines: Line[] = [{
    text: `agents  ${running.length} running, ${finished} finished${stopped ? ` (${stopped} stopped)` : ''}`,
    isDim: running.length === 0,
  }]
  const width = Math.min(40, Math.max(0, ...listed.map(a => a.label.length)))
  for (const a of listed) {
    lines.push({
      text: `  ${clock(a.startedAt, offsetMinutes)}  ${a.label.slice(0, 40).padEnd(width)}  running ${duration((now - a.startedAt) / 1000)}`,
    })
  }
  return lines
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workflow-monitor',
      description: 'Show or hide the band above the prompt with this session\'s workflow agents and this repo\'s /run-tickets run',
    })
    await readOffset($)
    await probeTicketPanes($)
    let ticks = 0
    $.clock.every(TICK_MS, () => {
      ticks += 1
      void (async () => {
        await update($, tick, n => n + 1)
        const now = await $.clock.now()
        if (now - lastDrawnAt > VISIBLE_MS) return
        const busy = (await read($, agents)).some(a => a.endedAt === undefined) || (await read($, run))?.state === 'running'
        if (ticks % (busy ? BUSY_POLL_TICKS : IDLE_POLL_TICKS) === 0) await poll($)
      })()
    })
    return next(e)
  })

  // A /clear goes on in this process under a new session and raises no session start, so
  // the offset is marked unread here and the next poll reads it again.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, offset, () => null)
    return next(e)
  }).catch(($, e, next) => next(e)) // nor does it ever hold up the session's end

  // Toggles the band. Hiding it keeps it hidden until shown again, even as new agents start.
  on('command.run', { command: 'workflow-monitor' }, async $ => {
    if ((await read($, visibility)) === 'shown') {
      await update($, visibility, () => 'hidden')
      return { text: 'Workflow monitor hidden. /workflow-monitor shows it again.' }
    }
    await update($, visibility, () => 'shown')
    await poll($)
    return { text: 'Workflow monitor shown above the prompt. /workflow-monitor hides it.' }
  })

  // Every agent a workflow script starts. Agents a resume replays from the journal are not raised.
  on('agent.spawn', async ($, e, next) => {
    if (!e.workflow) return next(e)
    const startedAt = await $.clock.now()
    const key = `${e.workflow.runId}#${e.workflow.agentIndex}@${startedAt}`
    const row: AgentRow = { key, runId: e.workflow.runId, label: e.description || `agent ${e.workflow.agentIndex}`, startedAt }
    await update($, agents, list => [...list, row].slice(-KEEP_AGENTS))
    // The session's first workflow agent shows the band, unless the person hid it.
    if ((await read($, visibility)) === 'unset') {
      await update($, visibility, () => 'shown')
      void poll($)
    }
    const started = await next(e)
    if (started.deny !== undefined) {
      await update($, agents, list => list.map(a => (a.key === key ? { ...a, endedAt: startedAt, isAborted: true } : a)))
    } else if (started.agentId) {
      const agentId = started.agentId
      await update($, agents, list => list.map(a => (a.key === key ? { ...a, agentId } : a)))
    }
    return started
  }).catch(($, e, next) => next(e)) // a monitor never stops a spawn: if this hook fails, the spawn goes on

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined && (await read($, agents)).some(a => a.agentId === id)) {
      const endedAt = await $.clock.now()
      await update($, agents, list => list.map(a => (a.agentId === id ? { ...a, endedAt, isAborted: e.isAborted } : a)))
    }
    return next(e)
  })

  // The band yields to a survey, and draws nothing until shown. Shown, it draws above
  // what the hooks beneath draw (another mod's band), so both show. The engine scrolls a
  // tree taller than its room, so every line is drawn.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, visibility)) !== 'shown') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, tick) // redraw on every tick, so running times move
    const now = await $.clock.now()
    lastDrawnAt = now
    const offsetMinutes = (await read($, offset)) ?? 0 // UTC until the offset is read
    const list = await read($, agents)
    const summary = await read($, run)
    const columns = Math.max(20, e.props.bodyColumns)
    const canOpen = canOpenTickets ?? (await probeTicketPanes($))

    const textRow = (line: Line) => (
      <Text dimColor={line.isDim === true}>{line.text.slice(0, columns) || ' '}</Text>
    )
    // `  [ x-2 ]  reviewing ...`: the rest is cut to what the indent and the button leave.
    const ticketRow = (line: TicketLine, width: number) => (
      <Box flexDirection="row" paddingLeft={2}>
        <Button key={`ticket-${line.id}`} label={line.id} dimColor={line.isDim} onPress={() => openTicket($, line.id)} />
        <Text dimColor={line.isDim}>
          {(' '.repeat(width - line.id.length) + line.rest).slice(0, Math.max(0, columns - 2 - (line.id.length + 4)))}
        </Text>
      </Box>
    )
    const runRows = (s: RunSummary): RenderElement[] => {
      if (!canOpen) return runLines(s, now).map(textRow)
      const since = sinceRead(s, now)
      const width = idWidth(s.open)
      return [...runHeader(s, since).map(textRow), ...s.open.map(t => ticketRow(ticketLine(t, since), width))]
    }

    const rows: RenderElement[] = []
    if (summary) rows.push(...runRows(summary))
    if (list.length) rows.push(...agentLines(list, now, offsetMinutes, new Set(summary?.open.map(t => t.id))).map(textRow))
    if (!rows.length) rows.push(textRow({ text: 'No workflow agents in this session yet.', isDim: true }))

    return (
      <Box flexDirection="column">
        {rows}
        {await next(e)}
      </Box>
    )
  })
}
