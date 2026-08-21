// A fixture, not a feature: the end-to-end check that `ctx.launch` works in the
// running app. It is committed because a hook only runs from a blob reachable
// from a commit, and it is removed as soon as the check has been made.
//
// IT IS GATED ON A SENTINEL, and that is the whole of its safety. A hook at
// `landed/agent/` that launches would otherwise fire on every landing an agent
// makes in this project — several a day, each creating a task — which is a
// runaway with a cost. The sentinel appears only in a message written to test
// this, so nothing else can reach the launch.
//
// It also exercises the properties the launch verb is supposed to have, so the
// task it creates is the evidence rather than a smoke signal: grants it asked
// for, the target's own provider, the backlink, and an origin that keeps this
// hook from being woken by the landing of the task it just made.

export const meta = { api: 1 }

const SENTINEL = 'LAUNCH_FIXTURE_7f3a'

export default async function onTurn(ctx) {
  const task = await ctx.target.read()
  const asked = (task.items ?? []).some(
    (it) => it.kind === 'message' && it.role === 'user' && (it.text ?? '').includes(SENTINEL),
  )
  if (!asked) return

  const result = await ctx.launch(
    `${SENTINEL} — you were created by a hook, to prove that a hook can create a task.\n\n` +
      `Do exactly this and nothing else:\n` +
      `1. Run: node /Users/rodovich/code/lander/daemon/task-fields-throwaway.mjs $LANDER_TASK\n` +
      `2. Reply with its output verbatim, and say whether you hold edit access.\n` +
      `3. Run: lander land`,
    // Granted deliberately: the point is that a hook confers what it asks for,
    // and that the record shows it.
    { edits: true, title: 'Launched by a hook' },
  )

  ctx.report(
    result.ok
      ? `Launched ${result.id}${result.deduped ? ' (deduped — this fire was retried)' : ''}.`
      : `Could not launch: ${result.reason}${result.error ? ` — ${result.error}` : ''}`,
  )
}
