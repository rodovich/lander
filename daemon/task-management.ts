import { createHash } from 'node:crypto'
import path from 'node:path'
import { projectDocBlock } from '../flow/project-doc'
import type { Ctx } from './flows/ctx'
import { isInside } from './paths'

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

export function checkoutNote({
  checkout,
  checkoutShared,
  root,
}: Pick<Ctx['task'], 'checkout' | 'checkoutShared' | 'root'>): string | undefined {
  if (checkout === undefined) return undefined
  if (checkoutShared) return `You are sharing your parent task's worktree at \`${checkout}\`.`
  return (
    `This task works in a git worktree lander created for it at \`${checkout}\`, ` +
    `starting detached at whatever the project's main checkout (\`${root}\`) had ` +
    'checked out. Commit on a branch you create, and switch branches here rather ' +
    'than making another worktree: lander removes this worktree when the task is ' +
    'landed or archived, and leaves branches alone. Managed tasks you launch share ' +
    'this worktree; pass `--worktree` to `lander launch` if one needs another branch ' +
    'or commit checked out, or will edit files that you or its siblings are editing.'
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

// One fact about the task an agent should keep in mind across turns, named so a
// changed fact can be told apart from the rest. An `everyTurn` part describes
// the turn itself, so it is sent whenever it applies.
export type ContextPart = { key: string; text: string; everyTurn?: true }

export function taskContextParts(
  task: Pick<
    Ctx['task'],
    'allow' | 'cwd' | 'recordedCwd' | 'checkout' | 'root' | 'watchers' | 'app'
  >,
  gitContext: (cwd: string) => string | undefined,
): ContextPart[] {
  const parts: ContextPart[] = []
  // The rules granted to this task, listed in full so a new grant changes the
  // part and is sent once.
  if (task.allow?.length)
    parts.push({
      key: 'grants',
      text:
        'Tool permissions granted to this task (beyond the defaults): ' +
        task.allow.map((rule) => `\`${rule}\``).join(', '),
    })
  // Read from where the shell starts — the task's checkout, when it has one.
  const git = gitContext(task.cwd)
  if (git) parts.push({ key: 'git', text: git })
  // The last turn's shell ended somewhere other than where this one launches.
  // Fires only when the two differ.
  //
  // In a lander-managed checkout it fires only for a dir inside the checkout.
  // One outside it is where the task worked before it had a checkout — the
  // root, for a task adopted into one — and pointing back there would send it
  // out of its checkout.
  if (
    task.recordedCwd &&
    task.recordedCwd !== task.cwd &&
    (!task.checkout || isInside(task.checkout, task.recordedCwd))
  )
    parts.push({
      key: 'cwd',
      text: manualCdHint(task.root, task.recordedCwd),
      everyTurn: true,
    })
  parts.push(...sharedParts(task))
  return parts
}

// The parts every flow's prompt draws on, whichever way the flow builds it.
function sharedParts(task: Pick<Ctx['task'], 'watchers' | 'app'>): ContextPart[] {
  return [watchersPart(task), appPart(task)].filter((p) => p !== undefined)
}

function appPart(task: Pick<Ctx['task'], 'app'>): ContextPart | undefined {
  if (!task.app) return undefined
  return {
    key: 'app',
    text:
      `This checkout's app is running at ${task.app.url}, started by the user through ` +
      'lander. Use it rather than starting another copy.',
  }
}

// The watchers the user has enabled, with what each takes.
export function watchersPart(task: Pick<Ctx['task'], 'watchers'>): ContextPart | undefined {
  if (!task.watchers?.length) return undefined
  const lines = task.watchers.flatMap((w) => [
    `- \`${w.name}\`: ${w.description}`,
    ...Object.entries(w.args).map(
      ([name, a]) => `  - \`--arg ${name}=…\`${a.required ? ' (required)' : ''}: ${a.description}`,
    ),
  ])
  return {
    key: 'watchers',
    text: [
      'Watchers you can arm with `lander ride --watch <watcher> --arg <key>=<value>`:',
      ...lines,
    ].join('\n'),
  }
}

// Deliberately silent on HOW: whether a location carries into the next turn
// depends on how the agent got there (a plain `cd` doesn't; Claude restores a
// worktree it entered itself), and that has changed under us before.
function manualCdHint(root: string, recordedCwd: string): string {
  const rel = path.relative(root, recordedCwd) || 'the project root'
  return (
    `Note: your previous turn ended in ${rel}. Depending how you moved there, ` +
    'that location may or may not have been preserved in this new turn. Check ' +
    '`pwd` before relying on the location.'
  )
}

// What to tell an agent when a part it was sent goes away. A part with no entry
// just stops being sent.
const GONE: Record<string, string> = {
  watchers: 'No watchers are enabled anymore; `lander ride --watch` will refuse.',
  app: "The app the user started through lander for this checkout is no longer running.",
}

// A record in its older form, the whole block as one string, counts as none.
export function changedContextParts(
  parts: ContextPart[],
  sessionId: string | undefined,
  sent: unknown,
): { send: ContextPart[]; record: Record<string, string>; changed: boolean } {
  const kept = parts.filter((p) => !p.everyTurn)
  const record = Object.fromEntries(kept.map((p) => [p.key, deliveryDigest(p.text)]))
  const before =
    sessionId && sent && typeof sent === 'object'
      ? (sent as Record<string, string>)
      : undefined
  const send = before
    ? parts.filter((p) => p.everyTurn || before[p.key] !== record[p.key])
    : [...parts]
  for (const key of Object.keys(before ?? {}))
    if (!(key in record) && GONE[key]) send.push({ key, text: GONE[key] })
  // A record left from an earlier session is replaced even when there is
  // nothing to send, or it would read as parts this session was told about.
  const changed = before
    ? Object.keys(before).length !== kept.length ||
      kept.some((p) => before[p.key] !== record[p.key])
    : kept.length > 0 || sent !== undefined
  return { send, record, changed }
}

// Dynamic facts belong at the cache-friendly end of the conversation, not in a
// system prompt where any change invalidates the whole cached prefix. Empty when
// there is nothing to report.
export function taskContextBlock(parts: ContextPart[]): string {
  if (!parts.length) return ''
  return [
    '<task-context>',
    'Task state as of this message — background context from lander, not ' +
      "the user's words. Each part is sent again when it changes.",
    '',
    parts.map((p) => p.text).join('\n\n'),
    '</task-context>',
  ].join('\n')
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
    task: Pick<
      Ctx['task'],
      'taskId' | 'root' | 'checkout' | 'checkoutShared' | 'watchers' | 'app'
    >
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
  const note = checkoutNote(ctx.task)
  const rendered = note ? `${taskPrompt}\n\n${note}` : taskPrompt
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
  const context = changedContextParts(
    sharedParts(ctx.task),
    sessionId,
    ctx.state.get(['contextParts']),
  )
  const block = taskContextBlock(context.send)
  const prompt = [
    ...(sendTaskPrompt ? [rendered] : []),
    ...(sendDoc && doc !== undefined ? [projectDocBlock(doc)] : []),
    ...turnPromptParts(ctx.turn),
    ...(block ? [block] : []),
  ].join('\n\n')
  return {
    prompt,
    commitDelivered() {
      if (sendTaskPrompt) ctx.state.set(['taskPrompt'], digest)
      if (sendDoc && docDigest !== undefined)
        ctx.state.set(['landerDoc'], docDigest)
      if (context.changed) ctx.state.set(['contextParts'], context.record)
    },
  }
}
