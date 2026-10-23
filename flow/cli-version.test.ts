import { expect, it } from 'vitest'
import { cliVersion } from './cli-version'

it('reads the version a CLI prints for --version, and nothing from one that cannot run', async () => {
  expect(await cliVersion(process.execPath)).toBe(process.versions.node)
  expect(await cliVersion('/nonexistent/lander-cli')).toBeUndefined()
})
