// A hook that does nothing, so the approval view has something to list. Nothing
// dispatches hooks yet — the trigger funnel and the runner are increment B — so
// this cannot run whether or not it is approved.
//
// Its twin at .lander/hooks/ride-ended/agent/demo.js is byte-identical, and
// therefore the same blob at a different path. Approving one must not approve the
// other: the trigger is in the path, so the same content fires at a different
// time from a different directory.

export const meta = { api: 1 }

export default async function onTurn(ctx) {
  await ctx.report('demo hook: still nothing to do, but a different version of it')
}
