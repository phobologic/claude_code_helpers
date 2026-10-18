import type { EngineInterface, On } from 'claude-code'

import type { Role } from './role'

// Switching the side pane from its ticket to another (D3). A stub: Task 2.3 replaces this file.

// What a click on another ticket did while the side agent was live: switched to it, or not.
export type SwitchResult = { kind: 'opened' | 'declined'; paneId?: string; waiting?: boolean }

// Decides a click on ticket `id` while `side`, the side-pane record, shows another ticket with its
// agent live. The stub never switches.
export async function decideSwitch($: EngineInterface, side: unknown, id: string): Promise<SwitchResult> {
  return { kind: 'declined' }
}

// This module's hooks, registered by register.tsx. None yet.
export function registerSwitch(on: On): void {}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known, possibly inside a draw, so it may start timers but never write `$.state`.
export async function switchReady($: EngineInterface, known: Role): Promise<void> {}
