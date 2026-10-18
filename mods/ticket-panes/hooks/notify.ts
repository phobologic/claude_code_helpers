import type { EngineInterface } from 'claude-code'

// The mod's toasts. A plugin's newer toast replaces its own one on show, so the messages of one
// open (the noun's `open`, between `beginNotices()` and `flushNotices($)`) are collected and shown
// as one toast when it ends; any other message is shown at once. Every module toasts through
// `notify`.

// The messages of the open in progress; undefined outside one.
let collected: string[] | undefined

// Starts collecting: the noun calls it as an open begins (one open runs at a time).
export function beginNotices(): void {
  collected = []
}

// Shows `msg`: at once, or with the rest of the open's messages when it ends.
export function notify($: EngineInterface, msg: string): void {
  if (collected === undefined) $.ui.toast(msg)
  else collected.push(msg)
}

// Ends the open: shows its messages as one toast, joined by `; `, and none when it had none.
export function flushNotices($: EngineInterface): void {
  const msgs = collected ?? []
  collected = undefined
  if (msgs.length > 0) $.ui.toast(msgs.join('; '))
}
