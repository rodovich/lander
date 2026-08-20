// A provider-backed one-shot: a prompt in, a reply out.
//
// This is the vehicle for judgment a body can make over inputs it already holds
// — supervision reading a closing message against its instruction — as distinct
// from judgment that has to explore, which launches a task and gets an agent
// with a transcript.
//
// It is deliberately thin. The provider comes from the target, so a Codex task's
// hook reasons with Codex and nothing branches on a provider name; the call runs
// where the rest of the body runs; and a caller wanting anything more particular
// reaches for `ctx.spawn`, which is this without the convenience.
//
// **The call inherits whatever the directory it runs in allows.** Probed: a
// one-shot issued inside a repository that pre-approves `Bash(git:*)` will run
// git. That is worth knowing when writing a judging prompt — a judge that goes
// exploring costs more and answers from whatever it happened to look at — but it
// is not a hole: the body already holds daemon privileges, so a tool the judge
// can reach is not a capability the body lacked.
//
// No server imports, by constraint: the hook host is spawned fresh for every
// fire, and a shared constant reached from here would be a server module
// arriving by a longer route.

import { spawn } from 'node:child_process'
import { codexConfigArgs, codexOptionsFromEnv } from './codex-config'

export type AssistProvider = 'claude' | 'codex'

export function isAssistProvider(value: unknown): value is AssistProvider {
  return value === 'claude' || value === 'codex'
}

export type AssistResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

// How long a one-shot may take before it is given up on. A judging call is a
// single inference over inputs the caller assembled, so this is generous rather
// than tight — and it sits inside the hook body's own budget, so a caller that
// overruns reports a failed judgment rather than being killed for it.
export const ASSIST_TIMEOUT_MS = 75_000

export type AssistInput = {
  provider: AssistProvider
  prompt: string
  cwd: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  // Test seam. Production passes nothing and gets a real child.
  spawnChild?: typeof spawn
}

// The argv each provider takes for a one-shot.
//
// Codex carries the deployment's profile and `--config` overrides, without which
// an instance whose model or credentials live in a lander profile would get a
// differently-configured call — or none at all. `--skip-git-repo-check` because a
// project need not be a git repository, and refusing to reason about one that
// is not would be a surprising place to fail.
export function assistArgv(
  provider: AssistProvider,
  prompt: string,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  if (provider === 'codex') {
    const { profile, configOverrides = [] } = codexOptionsFromEnv(env)
    return {
      command: 'codex',
      args: [
        'exec',
        '--skip-git-repo-check',
        ...codexConfigArgs(profile, configOverrides),
        '--',
        prompt,
      ],
    }
  }
  // `--` so a prompt beginning with a hyphen is taken as the prompt rather than
  // parsed as an option.
  return { command: 'claude', args: ['-p', '--', prompt] }
}

// Run the one-shot. Never throws and never exits: a body must be able to report
// that judgment was unavailable, which is a finding rather than a crash.
export function runAssist(input: AssistInput): Promise<AssistResult> {
  const { provider, prompt, cwd, timeoutMs = ASSIST_TIMEOUT_MS } = input
  const { command, args } = assistArgv(provider, prompt, input.env ?? process.env)
  const spawnChild = input.spawnChild ?? spawn

  return new Promise<AssistResult>((resolve) => {
    let child
    try {
      child = spawnChild(command, args, {
        cwd,
        env: { ...(input.env ?? process.env) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      return resolve({
        ok: false,
        error: `could not run ${command}: ${e instanceof Error ? e.message : String(e)}`,
      })
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (result: AssistResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // Deliberately not unref'd: this timer is the thing that has to outlive a
    // provider that never answers.
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      settle({
        ok: false,
        error: `the ${provider} one-shot did not answer within ${Math.round(
          timeoutMs / 1000,
        )}s`,
      })
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e: Error) =>
      settle({ ok: false, error: `could not run ${command}: ${e.message}` }),
    )
    child.on('close', (code: number | null) => {
      if (code === 0) return settle({ ok: true, text: stdout.trim() })
      settle({
        ok: false,
        error:
          stderr.trim().split('\n').slice(-3).join('\n') ||
          `${command} exited ${code ?? 'on a signal'}`,
      })
    })
    // Nothing to say on stdin: the prompt is argv. Closing it stops a provider
    // that waits on it from hanging until the timeout.
    child.stdin?.on('error', () => {})
    child.stdin?.end()
  })
}
