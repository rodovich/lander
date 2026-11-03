// Watch checks as the server sees them: the bundled checks the primary daemon
// announced, and which of them the user has switched on.
//
// A check reads outside systems as the user, so none runs until the user switches
// it on in the Hooks panel. The switches are the user's, not a project's: a check
// runs with the same credentials in every project. Unlike hook approvals they are
// by name rather than content, because a bundled check is lander's own code and
// what the user is consenting to is what it does with their credentials.

import { readFile } from 'node:fs/promises'
import { mutateJson } from './store'
import type { CheckMeta } from './protocol'

let announced: CheckMeta[] = []

export function setAnnouncedChecks(list: CheckMeta[]): void {
  announced = list
}

export function announcedCheck(name: string): CheckMeta | undefined {
  return announced.find((c) => c.name === name)
}

export function announcedChecks(): CheckMeta[] {
  return announced
}

export type ChecksStore = { enabled: string[] }

function emptyChecksStore(): ChecksStore {
  return { enabled: [] }
}

export async function readChecksStore(file: string): Promise<ChecksStore> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<ChecksStore>
    return { enabled: Array.isArray(parsed.enabled) ? parsed.enabled : [] }
  } catch {
    return emptyChecksStore()
  }
}

export function setCheckEnabled(
  file: string,
  name: string,
  enabled: boolean,
): Promise<ChecksStore> {
  return mutateJson<ChecksStore>(file, emptyChecksStore, (store) => {
    const rest = (Array.isArray(store.enabled) ? store.enabled : []).filter(
      (n) => n !== name,
    )
    store.enabled = enabled ? [...rest, name] : rest
  })
}

// Why a watch on `name` may not run, or null when it may.
export async function checkRefusal(
  file: string,
  name: string,
): Promise<{ reason: 'unknown' | 'off'; message: string } | null> {
  if (!announcedCheck(name)) {
    const known = announced.map((c) => c.name).join(', ')
    return {
      reason: 'unknown',
      message: `no watch check named "${name}"${known ? ` (available: ${known})` : ''}`,
    }
  }
  const { enabled } = await readChecksStore(file)
  if (!enabled.includes(name))
    return {
      reason: 'off',
      message: `the ${name} check is not enabled; the user can enable it in lander's Hooks panel`,
    }
  return null
}
