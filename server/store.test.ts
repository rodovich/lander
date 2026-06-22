import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readTasks, readTask, writeTask, mutateTask } from './store'

type Rec = {
  session: string
  createdAt: string
  updatedAt?: string
  title?: string
  n?: number
}

let dir: string
const file = (id: string) => path.join(dir, `${id}.json`)
const rec = (over: Partial<Rec> & { session: string }): Rec => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lander-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readTasks', () => {
  it('returns [] when the dir does not exist', async () => {
    expect(await readTasks(path.join(dir, 'nope'))).toEqual([])
  })

  it('returns [] for an empty dir', async () => {
    expect(await readTasks(dir)).toEqual([])
  })

  it('skips non-.json entries, including mid-write .tmp files', async () => {
    await writeFile(file('a'), JSON.stringify(rec({ session: 'a' })))
    await writeFile(path.join(dir, 'a.json.deadbeef.tmp'), '{ partial')
    await writeFile(path.join(dir, 'notes.txt'), 'hello')
    await mkdir(path.join(dir, 'subdir'))
    const tasks = await readTasks<Rec>(dir)
    expect(tasks.map((t) => t.session)).toEqual(['a'])
  })

  it('skips unreadable/invalid-JSON files without aborting the listing', async () => {
    await writeFile(file('good'), JSON.stringify(rec({ session: 'good' })))
    await writeFile(file('bad'), 'not json {')
    const tasks = await readTasks<Rec>(dir)
    expect(tasks.map((t) => t.session)).toEqual(['good'])
  })

  it('sorts by updatedAt descending (newest first)', async () => {
    await writeFile(
      file('old'),
      JSON.stringify(rec({ session: 'old', updatedAt: '2026-01-01T00:00:00.000Z' })),
    )
    await writeFile(
      file('new'),
      JSON.stringify(rec({ session: 'new', updatedAt: '2026-03-01T00:00:00.000Z' })),
    )
    await writeFile(
      file('mid'),
      JSON.stringify(rec({ session: 'mid', updatedAt: '2026-02-01T00:00:00.000Z' })),
    )
    const tasks = await readTasks<Rec>(dir)
    expect(tasks.map((t) => t.session)).toEqual(['new', 'mid', 'old'])
  })

  it('falls back to createdAt when updatedAt is absent', async () => {
    // 'a' has no updatedAt (legacy record) but a newer createdAt; 'b' has an
    // older updatedAt. 'a' must sort first via the createdAt fallback.
    await writeFile(
      file('a'),
      JSON.stringify(rec({ session: 'a', createdAt: '2026-05-01T00:00:00.000Z' })),
    )
    await writeFile(
      file('b'),
      JSON.stringify(
        rec({ session: 'b', updatedAt: '2026-04-01T00:00:00.000Z' }),
      ),
    )
    const tasks = await readTasks<Rec>(dir)
    expect(tasks.map((t) => t.session)).toEqual(['a', 'b'])
  })
})

describe('readTask', () => {
  it('returns the parsed record for an existing file', async () => {
    const r = rec({ session: 'x', title: 'hi' })
    await writeFile(file('x'), JSON.stringify(r))
    expect(await readTask<Rec>(dir, 'x')).toEqual(r)
  })

  it('returns null for a missing file', async () => {
    expect(await readTask<Rec>(dir, 'ghost')).toBeNull()
  })

  it('returns null (not throw) for invalid JSON', async () => {
    await writeFile(file('broken'), '{ not json')
    expect(await readTask<Rec>(dir, 'broken')).toBeNull()
  })
})

describe('writeTask', () => {
  it('writes JSON that round-trips through readTask', async () => {
    const r = rec({ session: 'r', title: 'round', n: 7 })
    await writeTask(file('r'), r)
    expect(await readTask<Rec>(dir, 'r')).toEqual(r)
  })

  it('pretty-prints with two-space indentation', async () => {
    await writeTask(file('p'), rec({ session: 'p' }))
    const raw = await readFile(file('p'), 'utf8')
    expect(raw).toContain('\n  "session": "p"')
  })

  it('leaves no temp file behind (atomic rename)', async () => {
    await writeTask(file('a'), rec({ session: 'a' }))
    const entries = await readdir(dir)
    expect(entries).toEqual(['a.json'])
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })

  it('handles concurrent writes to different files without colliding', async () => {
    await Promise.all([
      writeTask(file('one'), rec({ session: 'one' })),
      writeTask(file('two'), rec({ session: 'two' })),
      writeTask(file('three'), rec({ session: 'three' })),
    ])
    const tasks = await readTasks<Rec>(dir)
    expect(tasks.map((t) => t.session).sort()).toEqual(['one', 'three', 'two'])
    expect((await readdir(dir)).some((e) => e.endsWith('.tmp'))).toBe(false)
  })
})

describe('mutateTask', () => {
  it('reads, applies the mutation, and persists it', async () => {
    await writeTask(file('m'), rec({ session: 'm', n: 1 }))
    await mutateTask<Rec>(file('m'), (t) => {
      t.n = (t.n ?? 0) + 1
      t.title = 'changed'
    })
    const after = await readTask<Rec>(dir, 'm')
    expect(after).toMatchObject({ n: 2, title: 'changed' })
  })

  it('reads fresh from disk, so it does not clobber an out-of-band edit', async () => {
    await writeTask(file('m'), rec({ session: 'm', title: 'orig', n: 1 }))
    // Simulate an HTTP endpoint editing a different field between writes.
    await writeFile(file('m'), JSON.stringify(rec({ session: 'm', title: 'edited', n: 1 })))
    await mutateTask<Rec>(file('m'), (t) => {
      t.n = 99
    })
    const after = await readTask<Rec>(dir, 'm')
    // The mutation lands, and the out-of-band title edit survives.
    expect(after).toMatchObject({ title: 'edited', n: 99 })
  })

  it('serializes overlapping mutations so neither update is lost', async () => {
    await writeTask(file('m'), rec({ session: 'm', n: 0 }))
    // Two concurrent read-modify-writes to the same file, each touching a
    // different field. mutateTask's read and write are not adjacent (the write
    // awaits a rename), so without per-file serialization the second reads the
    // pre-first state and its write clobbers the first's field. With it, the
    // second reads fresh and both survive.
    await Promise.all([
      mutateTask<Rec>(file('m'), (t) => { t.title = 'first' }),
      mutateTask<Rec>(file('m'), (t) => { t.n = 1 }),
    ])
    const after = await readTask<Rec>(dir, 'm')
    expect(after).toMatchObject({ title: 'first', n: 1 })
  })

  it('runs queued mutations in call order', async () => {
    await writeTask(file('m'), rec({ session: 'm', title: '' }))
    // Each reads the title and appends a marker. Only a serialized
    // read-append-write yields 'abc'; overlapping reads would each start from ''
    // and the last writer would leave a single character.
    await Promise.all([
      mutateTask<Rec>(file('m'), (t) => { t.title += 'a' }),
      mutateTask<Rec>(file('m'), (t) => { t.title += 'b' }),
      mutateTask<Rec>(file('m'), (t) => { t.title += 'c' }),
    ])
    expect((await readTask<Rec>(dir, 'm'))?.title).toBe('abc')
  })

  it('one failed mutation does not wedge the file’s queue', async () => {
    await writeTask(file('m'), rec({ session: 'm', n: 0 }))
    const boom = mutateTask<Rec>(file('m'), () => {
      throw new Error('boom')
    })
    await expect(boom).rejects.toThrow('boom')
    // A subsequent mutation on the same file still runs and persists.
    await mutateTask<Rec>(file('m'), (t) => { t.n = 7 })
    expect((await readTask<Rec>(dir, 'm'))?.n).toBe(7)
  })

  it('rejects when the file is missing', async () => {
    await expect(mutateTask<Rec>(file('absent'), () => {})).rejects.toThrow()
  })

  it('rejects on invalid JSON without writing', async () => {
    await writeFile(file('bad'), 'not json')
    await expect(mutateTask<Rec>(file('bad'), () => {})).rejects.toThrow()
    // The bad file is left untouched (no partial write).
    expect(await readFile(file('bad'), 'utf8')).toBe('not json')
  })
})
