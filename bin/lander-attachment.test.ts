import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const LANDER_BIN = path.join(BIN_DIR, 'lander')

function execLander(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [LANDER_BIN, ...args],
      { env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5_000 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          code: error && typeof error.code === 'number' ? error.code : 0,
        })
      },
    )
  })
}

function bareEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.LANDER_API
  delete env.LANDER_TASK
  delete env.LANDER_PROJECT
  delete env.LANDER_TOKEN
  delete env.LANDER_FILES_DIR
  return env
}

async function makeFilesDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lander-att-'))
  await writeFile(path.join(dir, 'id-a'), 'a,b\n1,2\n')
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify([{ id: 'id-a', name: 'data.csv', mime: 'text/csv', size: 8 }]),
  )
  return dir
}

// A stub of the publish endpoint that records what it was sent and replies with
// whatever ref the test wants, so `put` can be exercised end to end without the
// real server.
type Captured = { url: string; headers: Record<string, string>; body: string }
function stubServer(reply: (n: number) => unknown): Promise<{
  origin: string
  captured: Captured[]
  close: () => Promise<void>
}> {
  const captured: Captured[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      captured.push({
        url: req.url ?? '',
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply(captured.length - 1)))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        origin: `http://127.0.0.1:${port}`,
        captured,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

describe('lander attachment', () => {
  it('ls and cat read the local store', async () => {
    const dir = await makeFilesDir()
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const env = { ...bareEnv(), LANDER_FILES_DIR: dir }

    const ls = await execLander(['attachment', 'ls'], env)
    expect(ls.code).toBe(0)
    expect(ls.stdout).toContain('data.csv')

    const cat = await execLander(['attachment', 'cat', 'id-a'], env)
    expect(cat.code).toBe(0)
    expect(cat.stdout).toBe('a,b\n1,2\n')
  })

  it('ls numbers each run in first-appearance order', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-att-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    // Two turns, plus a row written before runs were stamped.
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify([
        { id: 'old', name: 'legacy.txt', mime: 'text/plain', size: 1 },
        { id: 'a', name: 'shot.png', mime: 'image/png', size: 2, run: 'ride-1' },
        { id: 'b', name: 'notes.md', mime: 'text/markdown', size: 3, run: 'ride-1' },
        { id: 'c', name: 'shot.png', mime: 'image/png', size: 4, run: 'ride-2' },
      ]),
    )
    const { stdout, code } = await execLander(['attachment', 'ls'], {
      ...bareEnv(),
      LANDER_FILES_DIR: dir,
    })
    expect(code).toBe(0)
    const rows = stdout.trim().split('\n')
    // An unstamped row reads as turn 0 rather than claiming a turn of its own.
    expect(rows[0]).toContain('0/legacy.txt')
    expect(rows[1]).toContain('1/shot.png')
    expect(rows[2]).toContain('1/notes.md')
    // The second turn's same-named file is distinguishable by its prefix, and
    // still addressable by the id in the first column.
    expect(rows[3]).toContain('2/shot.png')
    expect(rows[3]).toContain('c')
  })

  it('put stamps the run it was attached on', async () => {
    const dir = await makeFilesDir()
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const src = path.join(dir, 'out.txt')
    await writeFile(src, 'x')
    const stub = await stubServer(() => ({
      attachment: { id: 'blob-9', name: 'out.txt', mime: 'text/plain', size: 1 },
      hosted: true,
    }))
    cleanups.push(stub.close)

    await execLander(['attachment', 'put', src], {
      ...bareEnv(),
      LANDER_API: stub.origin,
      LANDER_TASK: 'task-1',
      LANDER_PROJECT: 'proj',
      LANDER_TOKEN: 'secret',
      LANDER_FILES_DIR: dir,
      LANDER_RUN: 'ride-7',
    })
    const manifest = JSON.parse(
      await readFile(path.join(dir, 'manifest.json'), 'utf8'),
    ) as { id: string; run?: string }[]
    expect(manifest.find((m) => m.id === 'blob-9')?.run).toBe('ride-7')
  })

  it('cat rejects a path-escaping id', async () => {
    const dir = await makeFilesDir()
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const { stderr, code } = await execLander(
      ['attachment', 'cat', '../manifest.json'],
      { ...bareEnv(), LANDER_FILES_DIR: dir },
    )
    expect(code).not.toBe(0)
    expect(stderr).toContain('invalid attachment id')
  })

  it('put sends the file to the task-scoped route and caches it locally', async () => {
    const dir = await makeFilesDir()
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const src = path.join(dir, 'report.md')
    await writeFile(src, '# hi\n')
    const stub = await stubServer(() => ({
      attachment: {
        id: 'blob-1',
        name: 'report.md',
        mime: 'text/markdown',
        size: 5,
      },
      hosted: true,
    }))
    cleanups.push(stub.close)

    const { stdout, stderr, code } = await execLander(['attachment', 'put', src], {
      ...bareEnv(),
      LANDER_API: stub.origin,
      LANDER_TASK: 'task-1',
      LANDER_PROJECT: 'proj',
      LANDER_TOKEN: 'secret',
      LANDER_FILES_DIR: dir,
    })
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('report.md  blob-1  5')

    // Posted to the task's own attachment route, authenticated as that task.
    expect(stub.captured).toHaveLength(1)
    const [req] = stub.captured
    expect(req.url).toBe('/api/proj/tasks/task-1/attachments')
    expect(req.headers['x-lander-task']).toBe('task-1')
    expect(req.headers['x-lander-token']).toBe('secret')
    expect(req.body).toContain('# hi')

    // Cached into the local store, so `cat` works with no round-trip and the
    // manifest lists it alongside the inputs the daemon materialized.
    expect(await readFile(path.join(dir, 'blob-1'), 'utf8')).toBe('# hi\n')
    const manifest = JSON.parse(
      await readFile(path.join(dir, 'manifest.json'), 'utf8'),
    ) as { id: string; name: string }[]
    expect(manifest.map((m) => m.id).sort()).toEqual(['blob-1', 'id-a'])

    const cat = await execLander(['attachment', 'cat', 'blob-1'], {
      ...bareEnv(),
      LANDER_FILES_DIR: dir,
    })
    expect(cat.stdout).toBe('# hi\n')
  })

  it('warns when the server found no turn to attach it to', async () => {
    const dir = await makeFilesDir()
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const src = path.join(dir, 'orphan.txt')
    await writeFile(src, 'x')
    const stub = await stubServer(() => ({
      attachment: { id: 'blob-2', name: 'orphan.txt', mime: 'text/plain', size: 1 },
      hosted: false,
    }))
    cleanups.push(stub.close)

    const { stderr, code } = await execLander(['attachment', 'put', src], {
      ...bareEnv(),
      LANDER_API: stub.origin,
      LANDER_TASK: 'task-1',
      LANDER_PROJECT: 'proj',
      LANDER_TOKEN: 'secret',
      LANDER_FILES_DIR: dir,
    })
    // Still a success — the blob is stored — but the agent is told the user
    // will not see it.
    expect(code).toBe(0)
    expect(stderr).toContain('not attached to any turn')
  })

  it('errors when LANDER_FILES_DIR is unset', async () => {
    const { stderr, code } = await execLander(['attachment', 'ls'], bareEnv())
    expect(code).not.toBe(0)
    expect(stderr).toContain('LANDER_FILES_DIR')
  })

  it('guards missing arguments and a missing API', async () => {
    const usage = await execLander(['attachment', 'put'], bareEnv())
    expect(usage.code).not.toBe(0)
    expect(usage.stderr).toContain('usage: lander attachment put')

    const bogus = await execLander(['attachment', 'bogus'], bareEnv())
    expect(bogus.code).not.toBe(0)
    expect(bogus.stderr).toContain('usage: lander attachment')

    const noApi = await execLander(['attachment', 'put', 'x.txt'], bareEnv())
    expect(noApi.code).not.toBe(0)
    expect(noApi.stderr).toContain('LANDER_API')
  })
})
