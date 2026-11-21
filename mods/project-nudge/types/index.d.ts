/** Each pinned file's git blob hash, by repo-relative path. */
export type Hashes = Record<string, string>

/** What the band shows, decided after each run of the project's script. */
export type NudgeView =
  /** No .claude/nudge/ here, the repo is set to "never", or the script said nothing to do. */
  | { kind: 'none' }
  /** .claude/nudge/ exists but this repo has no allow/never answer yet. `hashes` is what Allow pins. */
  | { kind: 'ask'; root: string; files: string[]; hashes: Hashes }
  /** Allowed before, but a pinned file changed since: not run until approved again. */
  | { kind: 'changed'; root: string; files: string[]; hashes: Hashes; changed: string[]; since: string | null }
  /** The script's nudge. */
  | { kind: 'nudge'; root: string; title: string; lines: string[]; command: string | null }
  /** The script failed or broke the contract. `setup`: the contract was broken, so /nudge-setup can help. */
  | { kind: 'error'; root: string; summary: string; detail: string[]; setup: boolean }

declare module 'claude-code' {
  interface PluginState {
    'project-nudge': {
      view: NudgeView
      /** The key of the view the person dismissed; it stays hidden until the view changes. */
      dismissed: string | null
    }
  }
}
