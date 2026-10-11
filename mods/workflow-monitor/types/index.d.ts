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

// The newest /run-tickets run of the session's repo, from run-tickets-status --json.
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

declare module 'claude-code' {
  interface PluginState {
    'workflow-monitor': {
      agents: AgentRow[]
      run: RunSummary | null
      tick: number
      utcOffsetMinutes: number
      // The person hid the pane: new workflow agents do not open it again until they show it.
      isHidden: boolean
    }
  }
}
