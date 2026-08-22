import { describe, expect, it } from 'vitest'
import {
  migrateLegacyTaskValues,
  taskHref,
  taskKey,
  taskKeyOf,
  taskRefFromPath,
} from './taskRef'
import type { TaskLink } from './types'

describe('task references', () => {
  it('qualifies equal ids by project', () => {
    expect(taskKey('one', 'same')).toBe('one/same')
    expect(taskKey('two', 'same')).toBe('two/same')
    expect(
      taskKeyOf({ projectSlug: 'two', id: 'same' } as Parameters<
        typeof taskKeyOf
      >[0]),
    ).toBe('two/same')
  })

  it('round-trips exact task routes', () => {
    expect(taskHref('project', 'task')).toBe('/project/task')
    expect(taskRefFromPath('/project/task')).toEqual({
      projectSlug: 'project',
      id: 'task',
    })
    expect(taskRefFromPath('/project/task/artifacts')).toBeNull()
    expect(taskRefFromPath('/')).toBeNull()
  })

  it('migrates legacy values only when an id has one global owner', () => {
    const link = (projectSlug: string, id: string): TaskLink => ({
      projectSlug,
      id,
      title: id,
      status: 'resting',
      archived: false,
    })
    expect(
      migrateLegacyTaskValues(
        { unique: 'move', duplicate: 'do not guess', 'one/current': 'keep' },
        [
          link('one', 'unique'),
          link('one', 'duplicate'),
          link('two', 'duplicate'),
          link('one', 'current'),
        ],
      ),
    ).toEqual({
      'one/unique': 'move',
      duplicate: 'do not guess',
      'one/current': 'keep',
    })
  })
})
