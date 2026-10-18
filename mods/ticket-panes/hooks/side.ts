import type { EngineInterface, On } from 'claude-code'

import type { Role } from './role'

// The side agent's priming, ticket-change notes and session record. A stub: Task 3.5 replaces
// this file.

// This module's hooks, registered by register.tsx. None yet.
export function registerSide(on: On): void {}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known, possibly inside a draw, so it may start timers but never write `$.state`.
export async function sideReady($: EngineInterface, known: Role): Promise<void> {}
