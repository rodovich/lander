// Child-process plumbing shared by the daemon, its host processes, and what
// those hosts spawn. Node builtins only, so a hook host can import it.

import {
  spawn,
  type ChildProcess,
  type StdioOptions,
} from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from './paths'

// Spawn a host process running a TypeScript entry. Three things are
// load-bearing:
//
//   - **`node --import tsx <entry>`, not the `tsx` bin.** The bin is a wrapper
//     that re-spawns Node with three stdio entries, so any extra descriptor
//     opened here (the hook host's fd 3) never reaches the entry. daemon-watch
//     spawns the daemon the same way.
//   - **`cwd` is lander's own root**, because `--import tsx` resolves against
//     the child's cwd. At a project root it works in this repository and fails
//     with ERR_MODULE_NOT_FOUND in every other one. The directory the work
//     happens in travels in the host's input instead.
//   - **Detached**, so the host leads its own process group and
//     killProcessGroup takes everything it spawned down with it.
export function spawnHostProcess(
  entry: string,
  stdio: StdioOptions = ['pipe', 'pipe', 'pipe'],
): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: ROOT,
    detached: true,
    stdio,
    env: { ...process.env },
  })
}

// SIGKILL a host's whole process group, falling back to the host alone when
// the group signal isn't available.
export function killProcessGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}

// Write `input` to a child's stdin and close it, so a child that reads stdin to
// EOF can't hang on it. The error listener is attached first: closing races the
// child's own exit, and a child that has already gone fails the write with
// EPIPE — an 'error' event that, unlistened, is an uncaught exception in
// whichever process spawned it. Ignoring it is correct, because a read end
// that's already gone gives the same guarantee the close exists for.
export function endStdin(child: ChildProcess, input = ''): void {
  child.stdin?.on('error', () => {})
  child.stdin?.end(input)
}

// Call `onLine` with each non-empty, trimmed line a stream produces, holding a
// partial line until the chunk that completes it.
export function onLines(
  stream: NodeJS.ReadableStream | null | undefined,
  onLine: (line: string) => void,
): void {
  let buf = ''
  stream?.on('data', (d: Buffer | string) => {
    buf += d.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onLine(line)
    }
  })
}

// In a host: read stdin to its end and parse the first non-empty line, which
// is the one JSON input line the daemon writes.
export async function readInputLine<T>(host: string): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const line = Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .find((l) => l.trim())
  if (!line) throw new Error(`${host}: no input on stdin`)
  return JSON.parse(line) as T
}

// Whether the module at `moduleUrl` is the process entry, as opposed to being
// imported by a test.
export function isEntry(moduleUrl: string): boolean {
  return (
    !!process.argv[1] &&
    fileURLToPath(moduleUrl) === path.resolve(process.argv[1])
  )
}
