import { expect, it } from 'vitest'
import { usageStatus } from './usage'

const SOON = '2026-11-05T10:35:21.000Z'
const LATER = '2026-11-11T19:34:23.000Z'

it('names when the last used-up window resets', () => {
  expect(
    usageStatus({
      session: { utilization: 40, resetsAt: SOON },
      weekly: { utilization: 100, resetsAt: LATER },
    }),
  ).toMatchObject({ fullUntil: LATER })
  expect(
    usageStatus({
      session: { utilization: 100, resetsAt: SOON },
      weekly: { utilization: 100, resetsAt: LATER },
    }),
  ).toMatchObject({ fullUntil: LATER })
  expect(
    usageStatus({
      session: { utilization: 100, resetsAt: SOON },
      weekly: { utilization: 32, resetsAt: LATER },
    }),
  ).toMatchObject({ fullUntil: SOON })
})

it('names no reset while every window has room', () => {
  const status = usageStatus({
    session: { utilization: 99, resetsAt: SOON },
    weekly: { utilization: 32, resetsAt: LATER },
  })
  expect(status.fullUntil).toBeUndefined()
  expect(status.refreshAt).toBe('2026-11-05T10:35:23.000Z')
})
