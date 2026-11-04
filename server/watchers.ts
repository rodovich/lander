// Watchers as the server sees them: the bundled watchers the primary daemon
// announced, and which of them the user has switched on.
//
// A watcher reads outside systems as the user, so none runs until the user
// switches it on in the Hooks panel. The switches are the user's, not a
// project's: a watcher runs with the same credentials in every project. Unlike
// hook approvals they are by name rather than content, because a bundled watcher
// is lander's own code and what the user is consenting to is what it does with
// their credentials.

import { readFile } from 'node:fs/promises'
import { mutateJson } from './store'
import type { WatcherMeta } from './protocol'

let announced: WatcherMeta[] = []

export function setAnnouncedWatchers(list: WatcherMeta[]): void {
  announced = list
}

export function announcedWatcher(name: string): WatcherMeta | undefined {
  return announced.find((w) => w.name === name)
}

export function announcedWatchers(): WatcherMeta[] {
  return announced
}

export type WatchersStore = { enabled: string[] }

function emptyWatchersStore(): WatchersStore {
  return { enabled: [] }
}

export async function readWatchersStore(file: string): Promise<WatchersStore> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<WatchersStore>
    return { enabled: Array.isArray(parsed.enabled) ? parsed.enabled : [] }
  } catch {
    return emptyWatchersStore()
  }
}

export function setWatcherEnabled(
  file: string,
  name: string,
  enabled: boolean,
): Promise<WatchersStore> {
  return mutateJson<WatchersStore>(file, emptyWatchersStore, (store) => {
    const rest = (Array.isArray(store.enabled) ? store.enabled : []).filter(
      (n) => n !== name,
    )
    store.enabled = enabled ? [...rest, name] : rest
  })
}

// Why a watch on `name` may not run, or null when it may.
export async function watcherRefusal(
  file: string,
  name: string,
): Promise<{ reason: 'unknown' | 'off'; message: string } | null> {
  if (!announcedWatcher(name)) {
    const known = announced.map((w) => w.name).join(', ')
    return {
      reason: 'unknown',
      message: `no watcher named "${name}"${known ? ` (available: ${known})` : ''}`,
    }
  }
  const { enabled } = await readWatchersStore(file)
  if (!enabled.includes(name))
    return {
      reason: 'off',
      message: `the ${name} watcher is not enabled; the user can enable it in lander's Hooks panel`,
    }
  return null
}
