import { describe, expect, it, vi } from 'vitest'
import { createWakeHold, type WakeChild } from './power'

// Unit tests for the caffeinate hold daemon/index.ts takes while it rides a run.
// The spawn is injected, so these assert on the argv and the handle's lifetime
// rather than on any real assertion.

function fakeChild(): WakeChild & {
  kill: ReturnType<typeof vi.fn<() => void>>
  unref: ReturnType<typeof vi.fn<() => void>>
  fire: (event: 'error' | 'exit') => void
} {
  const listeners = new Map<string, () => void>()
  return {
    kill: vi.fn<() => void>(),
    unref: vi.fn<() => void>(),
    on: (event, listener) => void listeners.set(event, listener),
    fire: (event) => listeners.get(event)?.(),
  }
}

function make(platform = 'darwin') {
  const children: ReturnType<typeof fakeChild>[] = []
  const spawn = vi.fn(() => {
    const child = fakeChild()
    children.push(child)
    return child
  })
  const wake = createWakeHold({ spawn, platform, pid: 4242 })
  return { wake, spawn, children }
}

describe('wake hold', () => {
  it('asserts against system sleep, AC-only, watching the daemon pid', () => {
    const { wake, spawn } = make()
    wake.hold()
    expect(spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', [
      '-s',
      '-w',
      '4242',
    ])
    expect(wake.held()).toBe(true)
  })

  it('does not keep the daemon loop alive', () => {
    const { wake, children } = make()
    wake.hold()
    expect(children[0].unref).toHaveBeenCalled()
  })

  it('is idempotent, so every start-run can call it without counting', () => {
    const { wake, spawn } = make()
    wake.hold()
    wake.hold()
    wake.hold()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('kills the assertion on release, and releasing twice is harmless', () => {
    const { wake, children } = make()
    wake.hold()
    wake.release()
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    expect(wake.held()).toBe(false)
    wake.release()
    expect(children[0].kill).toHaveBeenCalledTimes(1)
  })

  it('re-holds after a release, so the next ride gets its own assertion', () => {
    const { wake, spawn } = make()
    wake.hold()
    wake.release()
    wake.hold()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(wake.held()).toBe(true)
  })

  it('forgets a handle that died on its own and re-spawns on the next hold', () => {
    const { wake, spawn, children } = make()
    wake.hold()
    children[0].fire('exit')
    expect(wake.held()).toBe(false)
    wake.hold()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('treats an async spawn failure the same way', () => {
    const { wake, children } = make()
    wake.hold()
    children[0].fire('error')
    expect(wake.held()).toBe(false)
  })

  it('survives a spawn that throws, holding nothing', () => {
    const spawn = vi.fn(() => {
      throw new Error('ENOENT')
    })
    const wake = createWakeHold({ spawn, platform: 'darwin', pid: 1 })
    expect(() => wake.hold()).not.toThrow()
    expect(wake.held()).toBe(false)
  })

  it('is inert off macOS', () => {
    const { wake, spawn } = make('linux')
    wake.hold()
    expect(spawn).not.toHaveBeenCalled()
    expect(wake.held()).toBe(false)
  })
})
