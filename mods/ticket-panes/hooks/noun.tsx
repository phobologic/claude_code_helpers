import type { EngineInterface, On } from 'claude-code'

import type { Role } from './role'

// The `$.ticketPanes` noun and the read-only ticket pane. A stub: Task 2.4 replaces this file.

// This module's hooks, registered by register.tsx. None yet.
export function registerNoun(on: On): void {}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known, possibly inside a draw, so it may start timers but never write `$.state`.
export async function nounReady($: EngineInterface, known: Role): Promise<void> {}
