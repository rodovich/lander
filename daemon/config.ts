// Lander's per-machine configuration: which projects it serves and how. It lives
// beside the daemon's other per-user state in `~/.lander` rather than in any
// project, because it describes this machine's lander, not the project — a
// repository shared with a team has no say in whether lander runs its agents
// in worktrees here.
//
//   { "projects": [ { "path": "~/code/app", "worktrees": true }, … ] }
//
// Read by dev.mjs for the project list, and by the daemon for per-project
// options. Pure apart from the file read, so the parse is testable on its own.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type ProjectConfig = {
  // Absolute and resolved, with `~` expanded.
  path: string
  // Give each task its own git worktree under `<path>/.worktrees/<task id>`.
  worktrees: boolean
}

export type LanderConfig = { projects: ProjectConfig[] }

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LANDER_CONFIG?.trim() || path.join(homedir(), '.lander', 'config.json')
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return path.join(home, p.slice(2))
  return p
}

// Parse and validate. Throws an error naming the file and the offending entry,
// so a typo stops lander at startup instead of quietly serving the wrong set.
export function parseConfig(
  text: string,
  file: string,
  home: string = homedir(),
): LanderConfig {
  const fail = (why: string): never => {
    throw new Error(`${file}: ${why}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return fail(`not valid JSON (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('expected an object')
  const projects = (raw as { projects?: unknown }).projects
  if (!Array.isArray(projects)) return fail('expected a "projects" array')
  return {
    projects: projects.map((entry, i): ProjectConfig => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        return fail(`projects[${i}] must be an object`)
      const { path: p, worktrees } = entry as { path?: unknown; worktrees?: unknown }
      if (typeof p !== 'string' || !p.trim())
        return fail(`projects[${i}].path must be a non-empty string`)
      if (worktrees !== undefined && typeof worktrees !== 'boolean')
        return fail(`projects[${i}].worktrees must be true or false`)
      return {
        path: path.resolve(expandHome(p.trim(), home)),
        worktrees: worktrees === true,
      }
    }),
  }
}

// The config, or undefined when the file does not exist. Any other failure —
// unreadable, malformed — throws.
export function readConfig(file: string = configPath()): LanderConfig | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  return parseConfig(text, file)
}

// The project list `npm run dev` serves: argv paths when given (a one-off run),
// else the config's. Throws with a message fit to print when there are none.
export function devProjectPaths(args: string[], file: string = configPath()): string[] {
  if (args.length) return args.map((a) => path.resolve(a))
  const paths = readConfig(file)?.projects.map((p) => p.path) ?? []
  if (!paths.length)
    throw new Error(
      `no projects: list them in ${file} ({"projects": [{"path": "/path/to/project"}]})` +
        ' or pass them: npm run dev /path/to/project [/path/to/another ...]',
    )
  return paths
}

// Per-project options for a long-lived reader. The file is re-read whenever its
// mtime changes, so flipping an option takes effect on the next ride without a
// restart. A file that goes missing reads as "no options"; one that becomes
// malformed keeps the last good read and logs, so a half-saved edit cannot flip
// a project's tasks out of their worktrees mid-conversation.
export function createProjectOptions(
  file: string = configPath(),
  log: (msg: string) => void = (msg) => console.error(msg),
): { worktrees(projectPath: string): boolean } {
  let mtimeMs: number | undefined
  let config: LanderConfig | undefined

  function current(): LanderConfig | undefined {
    let stamp: number | undefined
    try {
      stamp = statSync(file).mtimeMs
    } catch {
      mtimeMs = undefined
      config = undefined
      return undefined
    }
    if (stamp === mtimeMs) return config
    try {
      config = readConfig(file)
      mtimeMs = stamp
    } catch (e) {
      log(`lander config: ${e instanceof Error ? e.message : String(e)}; keeping the last good read`)
    }
    return config
  }

  return {
    worktrees(projectPath) {
      const resolved = path.resolve(projectPath)
      return !!current()?.projects.find((p) => p.path === resolved)?.worktrees
    },
  }
}
