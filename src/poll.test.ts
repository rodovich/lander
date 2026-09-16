import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPoll } from './poll'

// A job whose settlement the test controls, so the gap can be measured from the
// answer rather than from the question.
function controlledJob() {
  let calls = 0
  const settle: Array<() => void> = []
  const reject: Array<() => void> = []
  const job = () =>
    new Promise<void>((resolve, rej) => {
      calls++
      settle.push(resolve)
      reject.push(() => rej(new Error('failed')))
    })
  return { job, calls: () => calls, settle, reject }
}

// Let the promise chain between a settlement and the timer's arming flush.
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('startPoll', () => {
  it('runs at once, then a full gap after the answer — not after the question', async () => {
    const { job, calls, settle } = controlledJob()
    const stop = startPoll(job, 2000)
    await flush()
    expect(calls()).toBe(1)

    // The first answer is slow. The interval elapsing changes nothing.
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls()).toBe(1)

    settle[0]()
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls()).toBe(2)
    stop()
  })

  it('keeps going after a failure', async () => {
    const { job, calls, reject } = controlledJob()
    const stop = startPoll(job, 2000)
    await flush()
    reject[0]()
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls()).toBe(2)
    stop()
  })

  it('stops cleanly whether idle or mid-request', async () => {
    const idle = controlledJob()
    const stopIdle = startPoll(idle.job, 2000)
    await flush()
    idle.settle[0]()
    await flush()
    stopIdle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(idle.calls()).toBe(1)

    // Stopped while a request is in flight: its late answer must not rearm.
    const busy = controlledJob()
    const stopBusy = startPoll(busy.job, 2000)
    await flush()
    stopBusy()
    busy.settle[0]()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(busy.calls()).toBe(1)
  })
})
