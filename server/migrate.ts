// The versioned task reader: converts a task record read off disk into the shape
// the current server expects. Isolated in this one module by design (see
// docs/rides-plan.md) because it is the seam that rewrites task files — store.ts
// applies it as the `revive` hook on every read, and mutateTask persists the
// converted record on its next write. For now it does a single thing; step 4
// grows it into the full v1→v2 shape migration, keeping all shape-conversion
// logic here so the two-week cleanup can remove exactly this file's transitional
// code.

// Normalize a stored status to the collapsed vocabulary (`riding | wedged |
// landed`). A legacy `resting` record predates the collapse — idle is now a
// *derived* presentation of a `riding` task with no open ride (see publicTask), so
// it is never stored. Rewrites `resting` → `riding` and returns the record;
// idempotent (a record already in the collapsed vocabulary passes through
// untouched).
export function normalizeStatus<T extends { status?: string }>(raw: T): T {
  if (raw && raw.status === 'resting') raw.status = 'riding'
  return raw
}

// The reviver store.ts applies on every task read. Named separately from
// normalizeStatus so step 4 can swap the full `migrateTask` in here without
// touching the store's call sites (the reviver plumbing is put in place now with
// this single rule).
export function reviveTask<T extends { status?: string }>(raw: T): T {
  return normalizeStatus(raw)
}
