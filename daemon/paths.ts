import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Lander's install root, independent of the project a task runs against.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
