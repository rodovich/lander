import { describe, expect, it } from 'vitest'
import { SCRUBBED_ENV_KEYS, scrubProcessEnv, scrubbedEnv } from './secrets'

// A synthetic base throughout: the real process.env is shared by every test file
// in the worker, and the run env these assertions care about (LANDER_TOKEN et al)
// is composed per run by the server, never present in this process.
const base = (): NodeJS.ProcessEnv => ({
  HOME: '/Users/someone',
  PATH: '/usr/bin',
  SHELL: '/bin/zsh',
  LANDER_DAEMON_TOKEN: 'secret',
  LANDER_UI_TOKEN: 'secret',
  VITE_LANDER_UI_TOKEN: 'secret',
  LANDER_TOKEN: 'task-token',
  LANDER_API: 'http://localhost:6181',
  LANDER_PROJECT: 'proj',
  LANDER_TASK: 'abc123',
})

describe('scrubbedEnv', () => {
  it('drops every scrubbed key', () => {
    const out = scrubbedEnv(base())
    for (const key of SCRUBBED_ENV_KEYS) expect(out[key]).toBeUndefined()
  })

  it('preserves the task run env and the ordinary shell env', () => {
    const out = scrubbedEnv(base())
    // The negative control. LANDER_TOKEN is the task's OWN credential and the
    // whole point of the run env; dropping it would break `lander` in every task.
    expect(out.LANDER_TOKEN).toBe('task-token')
    expect(out.LANDER_API).toBe('http://localhost:6181')
    expect(out.LANDER_PROJECT).toBe('proj')
    expect(out.LANDER_TASK).toBe('abc123')
    expect(out.HOME).toBe('/Users/someone')
    expect(out.PATH).toBe('/usr/bin')
    expect(out.SHELL).toBe('/bin/zsh')
  })

  it('matches by exact name, not by LANDER_ prefix', () => {
    // The failure this guards: a prefix match (or the `PATH` + `LANDER_*`
    // allowlist sketched for flow env scrubbing) takes the run env with it —
    // and would not have caught LANDER_DAEMON_TOKEN anyway, since that matches
    // `LANDER_*` too.
    const out = scrubbedEnv({ ...base(), LANDER_UI_TOKEN_SUFFIX: 'keep' })
    expect(out.LANDER_UI_TOKEN_SUFFIX).toBe('keep')
    expect(Object.keys(out).filter((k) => k.startsWith('LANDER_'))).toEqual([
      'LANDER_TOKEN',
      'LANDER_API',
      'LANDER_PROJECT',
      'LANDER_TASK',
      'LANDER_UI_TOKEN_SUFFIX',
    ])
  })

  it('does not mutate the base it copies from', () => {
    const original = base()
    scrubbedEnv(original)
    expect(original.LANDER_UI_TOKEN).toBe('secret')
  })
})

describe('scrubProcessEnv', () => {
  it('mutates in place, leaving everything else', () => {
    const env = base()
    scrubProcessEnv(env)
    for (const key of SCRUBBED_ENV_KEYS) expect(env[key]).toBeUndefined()
    expect(env.LANDER_TOKEN).toBe('task-token')
    expect(env.HOME).toBe('/Users/someone')
  })

  it('is a no-op when the keys are already absent', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    scrubProcessEnv(env)
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})
