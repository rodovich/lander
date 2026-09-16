// Repeat an async job with a fixed gap after each settlement, so a slow or hung
// answer can never pile a second request on top of the first. A setInterval
// fires on schedule whether or not the previous request has returned; once
// responses run longer than the interval, the requests stack on the server's
// single thread and on the browser's per-origin connection budget, each one a
// full copy of the same payload, and anything else waiting for a connection
// queues behind them. (The 2026-09-15 launch burst held the new-task form's
// refresh behind stacked list polls for ~30s.)
//
// Runs `job` at once, then `delayMs` after it resolves OR rejects — the job owns
// its own error reporting, and a failure must not end the loop. stop() cancels
// the pending timer and refuses to rearm on a settlement that lands afterwards.
export function startPoll(
  job: () => Promise<unknown>,
  delayMs: number,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (stopped) return
    timer = setTimeout(run, delayMs)
  }
  const run = () => {
    timer = undefined
    void Promise.resolve().then(job).then(arm, arm)
  }
  run()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
