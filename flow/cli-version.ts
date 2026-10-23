import { execFile } from 'node:child_process'

// For a provider whose stream doesn't carry its CLI version.
export function cliVersion(cmd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, ['--version'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? undefined : /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0])
    })
  })
}
