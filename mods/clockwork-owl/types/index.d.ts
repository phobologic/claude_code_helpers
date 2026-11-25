/** What the owl is doing; each mood is a sprite. */
export type Mood = 'idle' | 'working' | 'waiting' | 'failed' | 'happy' | 'sleepy'

/** Where the pupils point. */
export type Look = 'center' | 'left' | 'right' | 'down'

/** Everything the owl's drawing reads. */
export type OwlView = {
  mood: Mood
  look: Look
  isBlinking: boolean
  /** The speech bubble's line, or null when the owl is quiet. */
  bubble: string | null
}

export type OwlPrefs = {
  /** No remarks at all, canned or Haiku; the owl still reacts. */
  isHushed: boolean
  /** The owl is not drawn. */
  isHidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clockwork-owl': {
      view: OwlView
      prefs: OwlPrefs
    }
  }
}
