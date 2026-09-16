import { describe, expect, it } from 'vitest'
import { taskApiHeaders } from './task-api'

describe('taskApiHeaders', () => {
  it('presents the task, project, and token from the run env', () => {
    expect(
      taskApiHeaders({
        LANDER_TASK: 'task-1',
        LANDER_PROJECT: 'proj',
        LANDER_TOKEN: 'secret',
        LANDER_API: 'http://localhost:6181',
      }),
    ).toEqual({
      'x-lander-task': 'task-1',
      'x-lander-project': 'proj',
      'x-lander-token': 'secret',
    })
  })

  it('omits what the env does not carry', () => {
    expect(taskApiHeaders({ LANDER_PROJECT: 'proj' })).toEqual({
      'x-lander-project': 'proj',
    })
  })
})
