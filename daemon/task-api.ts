// The identity a task presents to lander's API, taken from the run env the
// server issued it: the same headers bin/lander sends from inside the task.
export function taskApiHeaders(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return {
    ...(env.LANDER_TASK ? { 'x-lander-task': env.LANDER_TASK } : {}),
    ...(env.LANDER_PROJECT ? { 'x-lander-project': env.LANDER_PROJECT } : {}),
    ...(env.LANDER_TOKEN ? { 'x-lander-token': env.LANDER_TOKEN } : {}),
  }
}
