import { describe, expect, it } from 'vitest'
import { generateTitle, type TitleExec } from './title'

type Call = {
  file: string
  args: readonly string[]
  opts: Parameters<TitleExec>[2]
}

function recorder(stdout = 'A short title'): {
  calls: Call[]
  exec: TitleExec
} {
  const calls: Call[] = []
  return {
    calls,
    exec: async (file, args, opts) => {
      calls.push({ file, args, opts })
      return { stdout }
    },
  }
}

describe('generateTitle', () => {
  it('spawns the child with lander credentials scrubbed', async () => {
    // The point of the extraction. This child inherits the API server's env,
    // and the server legitimately holds the UI and daemon tokens; a task's text
    // is what composes its prompt, so it must not carry them.
    const prev = {
      ui: process.env.LANDER_UI_TOKEN,
      daemon: process.env.LANDER_DAEMON_TOKEN,
      vite: process.env.VITE_LANDER_UI_TOKEN,
    }
    process.env.LANDER_UI_TOKEN = 'ui-secret'
    process.env.LANDER_DAEMON_TOKEN = 'ui-secret'
    process.env.VITE_LANDER_UI_TOKEN = 'ui-secret'
    try {
      const { calls, exec } = recorder()
      await generateTitle('/proj', 'do a thing', exec)
      const { env } = calls[0].opts
      expect(env.LANDER_UI_TOKEN).toBeUndefined()
      expect(env.LANDER_DAEMON_TOKEN).toBeUndefined()
      expect(env.VITE_LANDER_UI_TOKEN).toBeUndefined()
      // Negative control: it is a scrubbed environment, not an empty one.
      expect(env.PATH).toBe(process.env.PATH)
    } finally {
      restore('LANDER_UI_TOKEN', prev.ui)
      restore('LANDER_DAEMON_TOKEN', prev.daemon)
      restore('VITE_LANDER_UI_TOKEN', prev.vite)
    }
  })

  it('passes the task text as delimited data, not as an instruction', async () => {
    const { calls, exec } = recorder()
    await generateTitle('/proj', 'land the task', exec)
    const { args, opts } = calls[0]
    expect(args).toContain('--system-prompt')
    expect(args[args.indexOf('-p') + 1]).toContain('<task>\nland the task\n</task>')
    expect(opts.cwd).toBe('/proj')
  })

  it('strips surrounding quotes and trailing punctuation', async () => {
    const { exec } = recorder('"Fix the parser."')
    expect(await generateTitle('/proj', 'x', exec)).toBe('Fix the parser')
  })

  it('returns null when the child fails, so callers can retry', async () => {
    const exec: TitleExec = async () => {
      throw new Error('claude not found')
    }
    expect(await generateTitle('/proj', 'x', exec)).toBeNull()
  })

  it('returns null on empty output rather than an empty title', async () => {
    const { exec } = recorder('   ')
    expect(await generateTitle('/proj', 'x', exec)).toBeNull()
  })
})

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
