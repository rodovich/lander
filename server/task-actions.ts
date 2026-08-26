import {
  pushTaskActionItem,
  type Item,
  type Ride,
  type TaskActionInput,
} from './tasks'

// The actor as this module needs it: an item log to append to, and the rides
// pushTaskActionItem reads to stamp the turn the action was taken during.
export type TaskActionActor = { items?: Item[]; rides?: Ride[] }

export type TaskActionMutator<T extends TaskActionActor> = (
  file: string,
  fn: (task: T) => void,
) => Promise<void>

// The longest echo of a sent message an action record carries. The same 4000
// characters a captured tool input takes: this copy is a reading convenience on
// the actor, so a long prompt must not bloat every sender's item log — the
// delivered text is stored whole on the recipient either way.
export const MAX_ACTION_TEXT = 4000

export function actionText(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return trimmed.length > MAX_ACTION_TEXT
    ? trimmed.slice(0, MAX_ACTION_TEXT) + '\n…'
    : trimmed
}

// Record a secondary, human-facing account of an action whose target mutation
// has already committed. Failure deliberately stays secondary: returning an
// error would invite a retry that can duplicate a launch or message. An actor
// may also be archived between authentication and this append; that ENOENT takes
// the same logged-and-resolved path.
export async function recordTaskAction<T extends TaskActionActor>(
  actorFile: string,
  action: TaskActionInput,
  at: string,
  mutate: TaskActionMutator<T>,
  log: (message: string, error: unknown) => void = console.error,
): Promise<void> {
  try {
    await mutate(actorFile, (task) => {
      pushTaskActionItem(task, action, at)
    })
  } catch (error) {
    log('failed to record acting task action:', error)
  }
}
