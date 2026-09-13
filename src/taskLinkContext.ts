import { createContext, useContext } from 'react'
import type { TaskLinkResolver } from './markdown'

// How a task id found in the conversation resolves to a link: provided once at
// the top of the app, read by the components that draw task mentions and chips,
// so the components between them don't carry it. The resolver is referentially
// stable (see resolveTaskLink), so providing it re-renders nothing.
//
// Outside a provider every id resolves to nothing, and a mention stays literal.
const TaskLinkContext = createContext<TaskLinkResolver>(() => undefined)

export const TaskLinkProvider = TaskLinkContext.Provider

export function useTaskLink(): TaskLinkResolver {
  return useContext(TaskLinkContext)
}
