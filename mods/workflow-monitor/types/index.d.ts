// One agent a workflow script's agent() started in this session.
export type AgentRow = {
  key: string
  runId: string
  label: string
  startedAt: number // ms since the epoch
  agentId?: string
  endedAt?: number
  isAborted?: boolean
}

// A ticket of the run that has not merged, as run-tickets-status describes it.
export type TicketRow = {
  id: string
  status: string
  isActive: boolean
  step?: string // the agent running now or last run, e.g. "review r2"
  startedClock?: string // local HH:MM that step started
  runningFor?: number // seconds the running step had run when the status was read
}

// The /run-tickets run the band shows, from run-tickets-status --json: the newest run of
// the session's repo that this session launched, else the repo's newest.
export type RunSummary = {
  runId: string
  state: string
  branch: string
  durationSeconds: number
  merged: number
  total: number
  mergeHalted: string
  open: TicketRow[]
  checkedAt: number // ms since the epoch when the status was read
}

// Whether the band shows: `unset` until the first workflow agent or /workflow-monitor shows
// it; `hidden` once the person hides it, so new agents do not show it again.
export type Visibility = 'unset' | 'shown' | 'hidden'

declare module 'claude-code' {
  interface PluginState {
    'workflow-monitor': {
      agents: AgentRow[]
      run: RunSummary | null
      tick: number
      utcOffsetMinutes: number
      visibility: Visibility
    }
  }
}
