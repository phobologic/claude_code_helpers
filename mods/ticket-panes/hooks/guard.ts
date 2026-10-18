import type { EngineInterface, On } from 'claude-code'

import type { Role } from './role'

// The side agent's tool guard. A stub: Task 3.3 replaces this file.

// This module's hooks, registered by register.tsx. None yet.
export function registerGuard(on: On): void {}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known, possibly inside a draw, so it may start timers but never write `$.state`.
export async function guardReady($: EngineInterface, known: Role): Promise<void> {}
