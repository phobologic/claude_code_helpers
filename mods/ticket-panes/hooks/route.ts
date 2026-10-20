import type { EngineInterface } from 'claude-code'

import { SidePaneError, agentName, closePane, field, herdr, launch, readSide, text } from './herdr'
import type { Launched, Side } from './herdr'
import { role } from './role'
import { decideSwitch } from './switch'

// Where a click on a ticket goes in a main session in herdr (R4). The noun's `open` (Task 2.4)
// calls `openSidePane` once per click, inside its open lock, and opens the read-only pane when it
// throws (D13). In order:
// 1. A live agent named for the ticket (E3) outside our record is focused (E11).
// 2. The record's side pane is still open but its agent has exited (the side session closes its
//    own panes when the person leaves it, so this is a Claude that crashed or was killed, or a
//    close that failed): the pane is closed, with its activity pane, and the ticket launched.
// 3. It shows the ticket: its agent is focused.
// 4. It shows another ticket: its agent is `decideSwitch`'s to switch from or keep (D3).
// 5. Otherwise the ticket is launched in a new side pane.

// What a click did. `opened`: the ticket's side agent was started in a new pane. `focused-own`:
// the side agent showing it was focused. `focused-foreign`: an agent for it outside our record was
// (E11). `declined`: the side pane was left on its ticket (D3). `paneId` is the pane opened or
// focused, and `waiting` says Claude started on a question there (D15).
export type OpenResult = {
  kind: 'opened' | 'focused-own' | 'focused-foreign' | 'declined'
  paneId?: string
  waiting?: boolean
}

// ---------- herdr ----------
// Each call goes through herdr.ts's runner, with its default timeout of 10 s.

// One `herdr agent list`, as a lookup: the pane of the live agent named `name`, or undefined when
// the list shows none. A list herdr does not give stops the click: without it, a launch could start
// a second Claude on the conversation an agent outside our record holds (E11).
async function listedPanes($: EngineInterface): Promise<(name: string) => string | undefined> {
  const ran = await herdr($, ['agent', 'list'])
  if (!ran.isOk) throw new SidePaneError('agent list', ran.reason)
  const agents = field(ran.result, 'agents')
  return name => text(Array.isArray(agents) ? agents.find(agent => text(agent, 'name') === name) : undefined, 'pane_id')
}

// Moves herdr's focus to agent `name`. A focus herdr refuses stops the click, so the person is told
// what failed (D13) instead of seeing nothing happen.
async function focusAgent($: EngineInterface, name: string): Promise<void> {
  const ran = await herdr($, ['agent', 'focus', name])
  if (!ran.isOk) throw new SidePaneError('agent focus', ran.reason)
}

// ---------- routing ----------

function opened(launched: Launched): OpenResult {
  return { kind: 'opened', ...launched }
}

// Step 2: the record's activity pane closes first (E4), then its side pane; readSide showed both
// ours. They close by pane id, not through exitAgent: an agent's name is free
// once it exits, and by now it may name a live agent in another session's pane, which exitAgent's
// keys and `/exit` would reach.
async function closeSide($: EngineInterface, side: Side): Promise<void> {
  if (side.activityPaneId !== undefined) await closePane($, side.activityPaneId)
  await closePane($, side.paneId)
}

// Routes a click on ticket `id` in a main session in herdr (R4), as the steps above say. A side
// session opens no side pane of its own (D12), so it is refused before any herdr call. Throws a
// SidePaneError naming the step that failed: here `agent list`, `agent get` or `agent focus`, and
// from herdr.ts `herdr pane`, `pane get`, `tickets dir`, `uuidgen`, `pane split` or `agent start`.
export async function openSidePane($: EngineInterface, id: string): Promise<OpenResult> {
  const { kind } = await role($)
  if (kind === 'side') throw new SidePaneError('side session', 'opens no side pane of its own')
  const side = await readSide($)
  const name = agentName(id)
  const paneOf = await listedPanes($)
  const pane = paneOf(name)
  const isOurs = side !== undefined && side.agentName === name && side.paneId === pane
  if (pane !== undefined && !isOurs) {
    await focusAgent($, name)
    return { kind: 'focused-foreign', paneId: pane }
  }
  if (side === undefined) return opened(await launch($, id))
  // readSide read the side agent as gone, but the list shows it in its pane: herdr's `agent get`
  // failed or missed it. The next step for a gone agent would close its pane over the live agent,
  // so the click stops (D13).
  if (!side.sideAgentLive && paneOf(side.agentName) === side.paneId) {
    throw new SidePaneError('agent get', `herdr lists ${side.agentName} in ${side.paneId} but did not show it there`)
  }
  if (!side.sideAgentLive) {
    await closeSide($, side)
    return opened(await launch($, id))
  }
  if (side.ticketId !== id) return decideSwitch($, side, id)
  await focusAgent($, side.agentName)
  return { kind: 'focused-own', paneId: side.paneId }
}
