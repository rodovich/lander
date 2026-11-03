import { createHash } from 'node:crypto'
import { projectDocBlock } from '../flow/project-doc'
import type { Ctx } from './flows/ctx'

// Deliver-once, for a flow whose channel for lander's own prose is the user
// message (e.g. codex and agy), where a block put in front of one turn stays in
// that turn's message forever and is replayed on every later one.
//
// The contract is a two-phase one, and the phases must stay split:
//
//   decide (before the spawn)  shouldDeliver(sessionId, ctx.state.get([key]), digest)
//   commit (after the turn)    ctx.state.set([key], digest) — only if it delivered
//                              AND the turn produced output
//
// "Produced output" is the whole safety argument: the model emitting a step or a
// reply proves it consumed the turn, which proves the thread exists, is durable,
// and holds that turn's user message. Committing earlier than that records a
// delivery that may not have happened, which is permanent; committing later, or
// never, costs one duplicate copy. Every failure direction must stay on the
// duplicate side.
export function deliveryDigest(text: string): string {
  // Stable across processes and versions — a per-process salt would re-deliver
  // every turn, the benign direction, but would look like success in a
  // single-session test. Prefixed so a future format change compares unequal
  // loudly rather than by accident.
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

// A delivery record describes a thread, so with no thread to resume nothing has
// been delivered, whatever the record says.
export function shouldDeliver(
  sessionId: string | undefined,
  delivered: unknown,
  digest: string,
): boolean {
  return !sessionId || delivered !== digest
}

export function fillTaskPrompt(taskPromptTemplate: string, id: string): string {
  return taskPromptTemplate.replace('{{id}}', id)
}

export function checkoutNote(checkout: string, root: string): string {
  return (
    `This task works in a git worktree lander created for it at \`${checkout}\`, ` +
    `starting detached at whatever the project's main checkout (\`${root}\`) had ` +
    'checked out. Commit on a branch you create: lander removes this worktree ' +
    'when the task is landed or archived, and leaves branches alone.'
  )
}

export function resolveProjectDoc(
  task: Pick<Ctx['task'], 'checkout' | 'root'>,
  readProjectDoc: (dir: string) => string | undefined,
): string | undefined {
  return (
    (task.checkout !== undefined ? readProjectDoc(task.checkout) : undefined) ??
    readProjectDoc(task.root)
  )
}

export function turnPromptParts(
  turn: Pick<
    Ctx['turn'],
    'prompts' | 'manifestBlock' | 'revivedBlock' | 'scheduledRideBlock'
  >,
): string[] {
  return [
    turn.prompts.join('\n\n'),
    turn.manifestBlock,
    turn.revivedBlock,
    turn.scheduledRideBlock,
  ].filter((part): part is string => part !== undefined)
}

export function prepareUserMessagePrompt(
  ctx: {
    task: Pick<Ctx['task'], 'taskId' | 'root' | 'checkout'>
    turn: Parameters<typeof turnPromptParts>[0]
    state: Pick<Ctx['state'], 'get' | 'set'>
  },
  {
    sessionId,
    taskPromptTemplate,
    readProjectDoc,
  }: {
    sessionId: string | undefined
    taskPromptTemplate: string
    readProjectDoc: (dir: string) => string | undefined
  },
): { prompt: string; commitDelivered(): void } {
  const taskPrompt = fillTaskPrompt(taskPromptTemplate, ctx.task.taskId)
  const rendered = ctx.task.checkout
    ? `${taskPrompt}\n\n${checkoutNote(ctx.task.checkout, ctx.task.root)}`
    : taskPrompt
  const digest = deliveryDigest(rendered)
  const sendTaskPrompt = shouldDeliver(
    sessionId,
    ctx.state.get(['taskPrompt']),
    digest,
  )
  const doc = resolveProjectDoc(ctx.task, readProjectDoc)
  const docDigest = doc === undefined ? undefined : deliveryDigest(doc)
  const sendDoc =
    docDigest !== undefined &&
    shouldDeliver(sessionId, ctx.state.get(['landerDoc']), docDigest)
  const prompt = [
    ...(sendTaskPrompt ? [rendered] : []),
    ...(sendDoc && doc !== undefined ? [projectDocBlock(doc)] : []),
    ...turnPromptParts(ctx.turn),
  ].join('\n\n')
  return {
    prompt,
    commitDelivered() {
      if (sendTaskPrompt) ctx.state.set(['taskPrompt'], digest)
      if (sendDoc && docDigest !== undefined)
        ctx.state.set(['landerDoc'], docDigest)
    },
  }
}
