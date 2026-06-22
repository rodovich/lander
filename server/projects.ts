// Project-path helpers: turn each configured project directory into the two
// identifiers the rest of the server keys off — a case-preserving on-disk dir
// name and a lowercased URL slug — and assemble the per-project data dirs.
// Pure given (root, env, cwd), so it can be unit-tested without the server.

import path from 'node:path'

export type Project = {
  path: string
  slug: string
  dataDir: string
  // Sibling of dataDir: ./data/<normalized-project-path>/runs, holding one
  // <runId>/ directory per turn (job spec, append-only output log, lease, done
  // marker). The runner writes these; the server only reads them.
  runsDir: string
  // Sibling of dataDir: ./data/<normalized-project-path>/archived, holding the
  // <uuid>.json files of archived tasks. Moving a task here takes it out of the
  // list (and out of the scheduler's and recovery's view, which only scan
  // dataDir); the UI's "Show archived" toggle reads it back in.
  archiveDir: string
  // Sibling of dataDir: ./data/<normalized-project-path>/flows, holding
  // <name>.js flow scripts. The server only resolves and hands back their path
  // (GET /api/:project/flows/:name); the `lander flow` CLI imports and runs them.
  flowsDir: string
}

// Namespace each project's tasks under ./data/<normalized-project-path>/tasks.
// e.g. /Users/me/code/myapp -> ./data/Users-me-code-myapp/tasks
export function normalizeProjectPath(p: string): string {
  const slug = path
    .resolve(p)
    .replace(/[/\\]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'default'
}

// URL-facing identifier for a project, e.g. /Users/me/code/myapp ->
// "users-me-code-myapp". Lowercased so it reads cleanly in the address bar; the
// on-disk data dir keeps the cased form from normalizeProjectPath above.
export function projectSlug(p: string): string {
  return normalizeProjectPath(p).toLowerCase()
}

// Projects come in newline-separated via PROJECT_DIRS (set by dev.mjs from the
// command-line args), falling back to the legacy single PROJECT_DIR, then cwd.
// Duplicate paths are dropped (keyed on slug); the first survivor is the default.
// `root` is the lander repo root under which the data dirs live.
export function parseProjects(
  root: string,
  env: Record<string, string | undefined>,
  cwd: string,
): Project[] {
  const raw = env.PROJECT_DIRS ?? env.PROJECT_DIR ?? cwd
  const paths = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const projects: Project[] = []
  for (const p of paths.length ? paths : [cwd]) {
    const resolved = path.resolve(p)
    const slug = projectSlug(resolved)
    if (seen.has(slug)) continue
    seen.add(slug)
    const norm = normalizeProjectPath(resolved)
    projects.push({
      path: resolved,
      slug,
      dataDir: path.join(root, 'data', norm, 'tasks'),
      runsDir: path.join(root, 'data', norm, 'runs'),
      archiveDir: path.join(root, 'data', norm, 'archived'),
      flowsDir: path.join(root, 'data', norm, 'flows'),
    })
  }
  return projects
}
