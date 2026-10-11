import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, RunSummary, TicketRow } from '../types'

// A pane with two parts:
// - the newest /run-tickets run of the session's repo, from `run-tickets-status --json`:
//   its progress and every ticket not merged yet, with when its current step started;
// - every agent a workflow script started in this session, newest first, with its
//   start time and how long it ran or has been running.
// Hooks modules have no Date, so clock times come from the UTC offset `date +%z` gives.

const PANE = 'workflow-monitor'
const TITLE = 'Workflows'
const TICK_MS = 15_000 // redraws running times
const BUSY_POLL_TICKS = 2 // read the run's status every 30s while something runs
const IDLE_POLL_TICKS = 20 // and every 5 minutes otherwise, to notice a run started elsewhere
const VISIBLE_MS = 60_000 // only while the pane has drawn within this long
const KEEP_AGENTS = 300

const agents = atom({ plugin: 'workflow-monitor', key: 'agents' } as const, [])
const run = atom({ plugin: 'workflow-monitor', key: 'run' } as const, null)
const tick = atom({ plugin: 'workflow-monitor', key: 'tick' } as const, 0)
const offset = atom({ plugin: 'workflow-monitor', key: 'utcOffsetMinutes' } as const, 0)
const hidden = atom({ plugin: 'workflow-monitor', key: 'isHidden' } as const, false)

// Module state: it starts over on a reload, which costs at most one extra open or poll.
let opened = false
let lastDrawnAt = 0
let polling = false

// ---------- formatting ----------

export function parseOffset(text: string): number {
  const m = /^([+-])(\d\d)(\d\d)/.exec(text.trim())
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

async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const out = await $.process.run(['run-tickets-status', '--json'], { timeoutMs: 60_000 })
    const checkedAt = await $.clock.now()
    if (out.exitCode !== 0) {
      // No run in this repo, or not a repo at all.
      await update($, run, () => null)
      return
    }
    const summary = summarize(JSON.parse(out.stdout) as Report, checkedAt)
    await update($, run, () => summary)
  } catch {
    // Not installed, too slow this time, or output it could not read: keep the last summary.
  } finally {
    polling = false
  }
}

// ---------- drawing ----------

type Line = { text: string; isDim?: boolean }

export function runLines(summary: RunSummary, now: number): Line[] {
  const since = summary.state === 'running' ? (now - summary.checkedAt) / 1000 : 0
  const lines: Line[] = [{
    text: `run-tickets ${summary.runId}  ${summary.state} ${duration(summary.durationSeconds + since)}  `
      + `merged ${summary.merged}/${summary.total}  ${summary.branch}`,
  }]
  if (summary.mergeHalted) lines.push({ text: `  MERGES HALTED: ${summary.mergeHalted}` })
  const width = Math.max(0, ...summary.open.map(t => t.id.length))
  for (const t of summary.open) {
    const when = t.isActive && t.startedClock
      ? `  started ${t.startedClock}  running ${duration((t.runningFor ?? 0) + since)}`
      : ''
    lines.push({ text: `  ${t.id.padEnd(width)}  ${t.status}${when}`, isDim: !t.isActive })
  }
  return lines
}

export function agentLines(list: readonly AgentRow[], now: number, offsetMinutes: number): Line[] {
  const newest = [...list].reverse()
  const width = Math.min(40, Math.max(0, ...newest.map(a => a.label.length)))
  return newest.map(a => {
    const took = a.endedAt === undefined
      ? `running ${duration((now - a.startedAt) / 1000)}`
      : `${duration((a.endedAt - a.startedAt) / 1000)}${a.isAborted ? '  stopped' : ''}`
    return { text: `${clock(a.startedAt, offsetMinutes)}  ${a.label.slice(0, 40).padEnd(width)}  ${took}`, isDim: a.endedAt !== undefined }
  })
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workflow-monitor',
      description: 'Show or hide the pane of workflow agents with their start times, and this repo\'s /run-tickets run',
    })
    try {
      const { stdout } = await $.process.run(['/bin/date', '+%z'])
      const minutes = parseOffset(stdout)
      await update($, offset, () => minutes)
    } catch {
      // Times show in UTC.
    }
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

  // Toggles the pane. Hiding it keeps it hidden until shown again, even as new agents start.
  on('command.run', { command: 'workflow-monitor' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await update($, hidden, () => true)
      await $.ui.close({ id: PANE })
      return { text: 'Workflow monitor hidden. /workflow-monitor shows it again.' }
    }
    opened = true
    await update($, hidden, () => false)
    await $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })
    await poll($)
    return { text: 'Workflow monitor shown. /workflow-monitor or Esc hides it.' }
  })

  // Closed by the person (its close mark, or Esc while it has the keys): stay hidden.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, hidden, () => true)
    return next(e)
  })

  // Every agent a workflow script starts. Agents a resume replays from the journal are not raised.
  on('agent.spawn', async ($, e, next) => {
    if (!e.workflow) return next(e)
    const startedAt = await $.clock.now()
    const key = `${e.workflow.runId}#${e.workflow.agentIndex}@${startedAt}`
    const row: AgentRow = { key, runId: e.workflow.runId, label: e.description || `agent ${e.workflow.agentIndex}`, startedAt }
    await update($, agents, list => [...list, row].slice(-KEEP_AGENTS))
    if (!opened && !(await read($, hidden))) {
      opened = true
      void $.ui.open({ id: PANE, title: TITLE })
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, tick) // redraw on every tick, so running times move
    const now = await $.clock.now()
    lastDrawnAt = now
    const offsetMinutes = await read($, offset)
    const list = await read($, agents)
    const summary = await read($, run)
    const columns = Math.max(20, e.props.bodyColumns)
    const room = Math.max(4, (e.viewport?.rows ?? 24) - 1)

    const lines: Line[] = []
    if (summary) lines.push(...runLines(summary, now), { text: '' })
    if (list.length) {
      lines.push({ text: 'agents (newest first)' }, ...agentLines(list, now, offsetMinutes))
    } else {
      lines.push({ text: 'No workflow agents in this session yet.', isDim: true })
    }

    return (
      <Box flexDirection="column">
        {lines.slice(0, room).map(line => (
          <Text dimColor={line.isDim === true}>{line.text.slice(0, columns) || ' '}</Text>
        ))}
      </Box>
    )
  })
}
