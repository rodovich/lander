# End-to-end testing in the running app

`npm test` covers pure logic — stream reducers, the task store, path/status
helpers, the markdown renderer. It cannot cover task *execution* or
*coordination*: what a real agent CLI does with the argv and environment the
daemon builds, what the permission layer actually blocks, what happens to an
in-flight run when the daemon relaunches, how a wakeup or an ask behaves across
turns, and what the user ends up seeing. Those only hold in the live three-process
stack, so changes to them get tested there before they are committed.

This document is the playbook for that testing. It is written for a task working
on lander itself, which is the usual case: the stack under test is the same stack
the task is running inside.

## The dev stack is the test environment

`npm run dev` runs the web client, the API server, and the host daemon together.
The client and server hot-reload on change. Editing `daemon/**` makes the dev
supervisor drain the running daemon (SIGUSR2) and spawn a fresh one, but the
superseded daemon refuses new runs and stays alive until its riding turns end —
so an in-flight turn survives the reload and reports into the updated server.

The practical rules that follow from that topology:

- **Transient broken *uncommitted* code is acceptable.** The running stack is the
  dev environment; a half-finished edit on disk is normal.
- **Never commit anything that does not work end-to-end**, and sequence changes
  so the reload → reconnect → resume cycle is never impeded. Both rules live in
  [docs/commit-authoring.md](commit-authoring.md); this topology is why they
  exist.
- **Verify recovery after each edit that touches `server/**` or `daemon/**`**,
  before moving on: the daemon handed off cleanly, the server reconnected, and
  other tasks in the instance kept making progress. Your edits reload a stack
  that is serving real work, including your own turn.

Confirm the stack is actually running before any live test. A task cannot read
the dev server's stdout, so observe it through the API, the `lander` CLI, and
task JSON under `data/`. If the stack is down, or a test needs a branch switch or
a restart, ask the user rather than restarting it yourself — they own that
terminal, and they will say when it is back up.

## Sibling tasks are the instrument

Subagents and direct `claude -p` / `codex exec` runs can be used to probe what
a harness does natively — whether a flag is honored, what an event stream emits,
etc. However, a finding there is a fact about the harness, not about lander, so
when testing a provider's behavior in this manner, **verify, don't assume, that
the result applies to the lander integration.**

Launch real tasks with `lander launch` and drive them with `lander send`. A
sibling task is the only instrument that runs in the real permission world, with
the real prompt, the real environment, and a real lifecycle that survives the
parent's turn.

Choose the cheapest instrument that is still faithful:

- **Test on yourself** when the behavior is self-directed — run the command you
  expect to be denied, wedge with options, rest with a wakeup, publish an
  artifact. Your own task is a real task.
- **Launch a sibling** when the subject is task creation, message delivery,
  inheritance, permission grants, or anything the parent cannot do to itself.
  Pass `--edits` only when the behavior under test needs it; a read-only
  instrument is the default and is itself a useful assertion. `--flow codex`
  launches it as a Codex task; without it you get the instance default.
- **Ask the user to drive the UI.** Anything that has to be seen or clicked — an
  ask's option buttons, a chip's disclosure, a status transition in the list — is
  verified by doing the thing and telling the user plainly what to look at and
  what counts as correct.

Cover both providers when making changes to task execution; such a change isn't
tested until it has run under Claude *and* Codex.

Remember that the parent is inside the system under test. Its own actions can
contaminate the measurement: a probe process the parent leaves running, a
mechanism the parent exercises before the code supporting it has landed, or a
`lander list` row the parent mistakes for a sibling (your own id is in your
prompt — check it).

## Writing an instrument prompt

An instrument's job is to produce trustworthy evidence, not to succeed. Prompts
that get that consistently share a shape:

- **Exact commands, one per tool call, in order.** Spell them out literally.
- **State the expected outcome for each step**, and ask for a `PASS`/`FAIL`
  verdict against it plus the **verbatim** error text on any failure.
- **Forbid routing around a failure** — no retries, no substituting a different
  tool or path to achieve the same end, continue past failures to the next step.
  A route-around destroys exactly the signal you launched for.
- **Bound the lifecycle explicitly**: whether it may edit files, commit, land, or
  wedge, and that it must do nothing else. Say what to do at the end — usually
  `lander land`, or "stop and leave the task open for review".
- **Require plain reporting of negatives.** "The wake never arrived" is a
  result. So is a forced protocol deviation — if the environment made a step
  impossible, that is a finding about the environment, to be reported as one and
  not worked around silently.
- **Never leave an ambiguous terminal state.** An instrument that cannot tell
  whether it passed should say so and stop, rather than picking an interpretation.
- **Script multi-turn protocols** when the subject is cross-turn behavior: which
  turn does what, what to poll and how often, and what not to end the turn on.

## What to assert

State the prediction before launching. An instrument that runs first and gets
interpreted afterward tends to confirm whatever was expected.

Assert the positive outcome, not the absence of a failure. "The ride completed
and returned the command's output" is a real assertion; "the ride did not wedge"
passes while the work still dies. Pair it with a **negative control** — the
safeguard you moved must still fire — so a fix that simply disables a protection
cannot pass.

Verify what the user and the next turn actually see, not only what the server
stored: the task record, the rendered conversation, the prompt the following turn
receives. And when a change rests on a claim about how the agent CLI or the
harness behaves, check that premise against the corpus (`data/`, or the harness's
own record) or a probe before building on it.

## Probes and scratch files

For anything the shell guard blocks — inline `node -e`, `python3`, pipelines with
expansions, `$VAR` in a path — write a throwaway script instead. The established
convention is `daemon/<name>-throwaway.mjs`, run as `node
daemon/<name>-throwaway.mjs`. Use literal paths in probes rather than variables,
both because the guard rejects expansions and because a literal path is what the
result is actually about.

Delete throwaway probes when the task concludes. They are untracked, so every
one left behind shows up in the git-status block of every future task in the
repo.

## Cleanup and reporting

Land or archive the throwaway tasks you launched, and remove probe files, scratch
branches, and worktrees. An instrument that is left riding keeps a run alive and
muddies the next test.

Report what you actually ran and observed, including the parts that failed. If a
planned verification could not be run as written, say that explicitly instead of
skipping it silently — an unrun check reported as done is worse than no check.
When a plan lists per-step verification, run each step's own verification before
moving to the next.

## Outward-facing actions

Testing stops at the boundary of anything the outside world sees. Exercise
push/PR-shaped paths in dry-run — performing every read, artifact, ask, and
re-entry while emitting the command instead of running it — and stop for explicit
user confirmation before the real thing. Do not open a PR, push, or send anything
outward on your own initiative as part of a test.
