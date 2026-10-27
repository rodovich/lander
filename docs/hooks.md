# Task hooks

A task hook is a JavaScript module committed to a project's repository that
lander runs when one of that project's tasks lands, wedges, or ends a ride. Write
or change one only when the user asks for it: an approved hook runs unattended,
as the user, with full access to their machine.

A hook does nothing until the user approves it in lander's **Hooks** panel (the
navbar button). An agent cannot approve one. When you write a hook, tell the user
to approve it there once it is committed.

## A hook's path says when it runs

A hook lives at exactly `.lander/hooks/<trigger>/<by>/<name>.js`. Any other
depth, or a file not ending in `.js`, is ignored. Directory names are not
checked, so a misspelled trigger or `<by>` is listed in the Hooks panel and
never fires.

`<trigger>` is one of:

| trigger | fires after the task… |
|---|---|
| `landed` | lands |
| `unlanded` | leaves landed, e.g. a reply revives it |
| `wedged` | wedges |
| `unwedged` | leaves wedged |
| `ride-ended` | finishes a ride with outcome `done` or `error` (not when interrupted) |

`<by>` is who caused the transition:

| by | meaning |
|---|---|
| `human` | the user, in lander's UI |
| `agent` | the task itself, e.g. `lander land` with no id |
| `task` | another task, e.g. a parent landing its child |
| `system` | lander itself or an unidentified caller: wedges from failed turns, usage limits and outages; scheduled deliveries, including the user's own `lander send --date`; `--await` wakes |
| `hook` | another hook's `ctx.land` or `ctx.nudge` |
| `any` | all of the above |

Every fire runs both `<trigger>/<by>/` and `<trigger>/any/`. `ride-ended` is only
ever `agent` (outcome `done`) or `system` (outcome `error`).

Hooks run after the transition, asynchronously: usually within about 15
seconds, later when other hooks are queued, and never in time to block or change
it. One task's hooks run one at a time.

## Only committed, approved versions run

Lander reads hooks from the HEAD commit of the task's checkout — its worktree,
with managed worktrees — never from the working tree. An uncommitted edit does
not run, and a task fires only the hooks its own HEAD contains.

The Hooks panel lists the hooks at the HEAD of the project root's checkout, so a
hook must be committed there before the user can approve it. Approval is per
path and version: after an edit, the previously approved version keeps running
until the user approves the new one, and a moved hook doesn't run until it is
approved at its new path. Fires for a hook
with no approved version are dropped silently and are not replayed after
approval. The user can instead designate a trusted remote branch in the panel,
whose hooks run without individual approval.

## The module exports `meta` and a default function

```js
export const meta = { api: 1 }

export default async function (ctx) {
  // …
}
```

`meta.api` must be `1`. The module is loaded as ESM from a temporary directory,
so relative imports and the project's packages don't resolve; use `node:`
built-ins. The body has 120 seconds.

The function receives `ctx`:

- `ctx.target` — the task the trigger fired on: `id`, `project`, `flow`, and
  `cwd` (the task's checkout, or the project root if that is gone).
  `await ctx.target.read()` returns its full record, including its conversation
  `items`, fetched once per run.
- `ctx.trigger` — `{ kind, by, at, rideId?, outcome? }`. `by` is the actual
  principal even when the hook lives under `any/`. `rideId` and `outcome` are
  set for `ride-ended`. The task may have moved on by the time the body runs;
  `at` is when the trigger fired.
- `ctx.hook` — `{ name, path, blob, fireId, trigger, by }` for the running hook.
- `ctx.project` — `{ slug, root }`.
- `ctx.stateDir` — a per-project directory for files the hook keeps between
  runs. Lander does not create it.
- `ctx.spawn(cmd, args, { cwd?, input? })` — runs a process without a shell or a
  timeout and resolves `{ code, stdout, stderr }` (`code` is -1 if it couldn't
  start). `cwd` defaults to the project root; pass `ctx.target.cwd` to work in
  the task's checkout.
- `ctx.assist(prompt, { timeoutMs? })` — a one-shot model call with the task's
  provider, run in the project root. Resolves `{ ok: true, text }` or
  `{ ok: false, error }`.
- `ctx.nudge(text)` — sends the task a message and starts a turn.
- `ctx.land()` — lands the task.
- `ctx.launch(message, { title?, flow? })` — creates a task.
- `ctx.report(text)` — adds a line to the hook's item on the task's timeline.

`nudge`, `land` and `launch` resolve `{ ok: true }` (with the new task's `id`
for `launch`) or `{ ok: false, reason, error }`, and a refusal is reported on the
timeline automatically. Lander refuses all three:

- past three actions by one hook on one task, until the user next acts on that
  task in the UI;
- once the task has landed, wedged, been revived, or received a user message
  since the trigger.

It also refuses `nudge` while the task is wedged, and `land` while it is wedged,
working, or waiting on a scheduled ride.

A hook's own `land` or `nudge` doesn't fire that hook again, but the ride a
`nudge` starts does end, so a `ride-ended` hook that nudges will see its own
nudge's ride. Tasks a hook launches never fire that hook.

## Results appear on the task's timeline

A run that called `ctx.report`, or that didn't succeed, adds a "hook `<name>`"
item to the task's conversation with the reports, the tail of the body's own
stdout and stderr (not `ctx.spawn` output), and any error. A run that succeeds
without reporting leaves no trace.

A run that throws or times out is reported, not retried. A body can still run
more than once for one fire: lander reruns one cut off by a server restart. Make
side effects safe to repeat; `ctx.hook.fireId` is the same across reruns of one
fire.

## Example

Run a cleanup script in the landed task's checkout, whoever landed it:
`.lander/hooks/landed/any/cleanup.js`.

```js
export const meta = { api: 1 }

export default async function (ctx) {
  const { code, stdout, stderr } = await ctx.spawn('bin/cleanup', [], {
    cwd: ctx.target.cwd,
  })
  if (code !== 0) throw new Error(`bin/cleanup exited ${code}: ${stderr}`)
  if (stdout.trim()) ctx.report(stdout.trim())
}
```

With managed worktrees, a landed task's worktree is removed only after its
pending hooks have run, so `ctx.target.cwd` still exists here.
