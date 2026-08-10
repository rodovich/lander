// The lander credentials that must never reach a child process.
//
// `dev.mjs` mints one UI token and hands it to all three processes; the API
// compares it by value to resolve the trusted-human principal, and the daemon
// presents it to authenticate its WebSocket upgrade. Everything downstream then
// spawns with `{ ...process.env }` — the flow host (daemon/run.ts), the agent
// child (daemon/flows/ctx.ts, daemon/run-agent.ts) — so the whole chain carried
// these into every task's shell, and a task presenting the value as
// `x-lander-ui-token` resolved as `ui`: the human browser, on every route, for
// every task, in every served project.
//
// A task's own credential is LANDER_TOKEN, which the server composes per run
// (server/index.ts) and which is deliberately NOT in this list.
//
// This file is imported by the daemon, so it is named in daemon-watch.mjs's
// WATCHED_SERVER_FILES: editing it hands the daemon off rather than leaving it
// running a stale list.
//
// MATCHING IS BY EXACT NAME, never by prefix. A `LANDER_*` glob would strip the
// run env the task needs — and would not have been a smaller list anyway, since
// LANDER_DAEMON_TOKEN matches it too.
export const SCRUBBED_ENV_KEYS = [
  'LANDER_DAEMON_TOKEN',
  'LANDER_UI_TOKEN',
  // dev.mjs sets this to the same value for Vite to inline into the client, so
  // it is a third copy of the same secret, not a separate one.
  'VITE_LANDER_UI_TOKEN',
] as const

// Remove them from the live environment, for a process that has already captured
// what it needs into module state. Every child spawned afterwards inherits the
// scrubbed copy, which is why this beats filtering at each spawn site: a new
// spawn site cannot forget it.
//
// Note this only affects processes exec'd AFTER the call. A process's own
// exec-time environment block — what `ps -E` reports — is a kernel snapshot
// taken at exec and is never rewritten by unsetenv, so this process keeps
// showing the old values there.
export function scrubProcessEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of SCRUBBED_ENV_KEYS) delete env[key]
}

// A scrubbed copy, for spawning one child out of an environment this process
// must keep intact (the API server needs its own tokens).
export function scrubbedEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const copy = { ...base }
  scrubProcessEnv(copy)
  return copy
}
