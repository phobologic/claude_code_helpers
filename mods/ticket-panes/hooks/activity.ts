import type { EngineInterface, On } from 'claude-code'

import type { Role } from './role'

// The run-activity pane below the side agent (D8). A stub: Task 2.5 replaces this file.

// Opens, keeps or closes the activity pane for ticket `id` once its side pane is placed. The stub
// does nothing.
export async function syncActivity($: EngineInterface, id: string): Promise<void> {}

// This module's hooks, registered by register.tsx. None yet.
export function registerActivity(on: On): void {}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known, possibly inside a draw, so it may start timers but never write `$.state`.
export async function activityReady($: EngineInterface, known: Role): Promise<void> {}
