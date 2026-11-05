# Agent CLI support

Lander drives three agent CLIs: Claude Code (`claude`), Codex (`codex`), and
Antigravity (`agy`). Each is a bundled driver flow in
[the flow registry](../daemon/flows/index.ts), which is the source of truth for
what is bundled. All three are meant to be first-class. Where one falls short of
another, this document says whether the CLI or lander's integration is the cause.

## Every flow integrates through the same boundary

The server and the web client hold no agent-specific knowledge. Each flow
declares capability metadata (`meta.capabilities`: which grant scopes it
supports, whether it publishes a usage snapshot, whether it can supply a
rate-limit reset time, whether it reports cost), and the server and client read
those flags instead of branching on a flow's name.
[docs/architecture.md](architecture.md#provider-layering) covers that rule. Two
exceptions remain in the server: task titles always come from `claude`
(`server/title.ts`), and the server maps a flow to its `lander assist` provider
by name.

Provider-specific mechanics live in the daemon: the flow modules
(`daemon/flows/<name>.ts`) and the helpers they use, such as
`daemon/codex-app-server.ts`, `daemon/codex-config.ts`, and `daemon/assist.ts`.
`server/usage.ts`, which holds Claude's usage fetch and the meter mapping all
three flows share, sits in the server directory but runs only in the daemon.
The API server owns task JSON, scheduling, queues,
statuses, and permission metadata. For each turn it sends the daemon a
provider-neutral `start-run` message: the project, the prompt, the stored
provider session id, cwd and worktree hints, and the `LANDER_*` environment. The
daemon starts a flow host for the turn, and inside it the flow builds argv,
spawns its CLI, and reduces the CLI's output into lander's normalized update
shape: activity steps, final text, usage, terminal errors, and the provider's
session id.

A conversation runs on headless CLI processes read through their documented
machine-readable output: `claude -p --output-format stream-json`,
`codex exec --json`, and `agy -p --output-format stream-json`. Each turn starts
a fresh process that resumes the provider's own session by id. The Antigravity
flow may start more than one in a turn (see below). Around that, flows use what
each CLI offers for the rest: its config files for permission grants, a hook
(Claude's Stop hook records the cwd), a debug log (agy's `--log-file`), and
short-lived side calls for facts the turn's output doesn't carry. The side calls
fetch usage meters and reset times, and for Codex the model and reasoning effort
a thread ran with. They are lookups, and none of them runs or changes a turn.

Lander does not parse the providers' private session stores
(`~/.claude/projects/**/*.jsonl`, Codex's `~/.codex/sessions` rollouts, agy's
conversation databases). Their formats are undocumented and change without
notice. When a fact exists only there, lander goes without it, unless the CLI
itself serves it through a published interface, as Codex's `thread/read` does.

Codex's app-server (`codex app-server`, JSON-RPC over stdio) is the side channel
for Codex. Its protocol is typed and published: `codex app-server
generate-json-schema --out <dir>` writes the schema for the installed version.
The CLI still labels the subcommand experimental. Lander uses it only for
one-request lookups (`daemon/codex-app-server.ts`) and still runs turns through
`codex exec`. Running turns through the app-server would bring approval requests
and mid-turn input (`turn/steer`), at the cost of replacing the per-turn process
model that permissions, restarts, and failure handling are built on.

## The flows differ in these ways

| | Claude | Codex | Antigravity |
|---|---|---|---|
| Turn command | `claude -p … --output-format stream-json` | `codex exec --json` | `agy -p … --output-format stream-json` |
| Session id | minted by lander (`--session-id`, then `--resume`) | `thread.started` in the stream, then `exec resume <id>` | `init` event's `conversation_id`, then `--conversation` |
| Task instructions | `--append-system-prompt`, every turn | user message, once per thread | user message, once per conversation |
| Edit boundary | `--permission-mode acceptEdits` plus `--add-dir` scratch roots | lander's `lander-edit` permission profile | `--mode accept-edits` plus `--add-dir` scratch roots |
| Grants | task and project (`.claude/settings.local.json`) | none | project (`~/.gemini/config/projects/lander-<hash>.json`) |
| Usage meters | Claude's OAuth usage endpoint | app-server `account/rateLimits/read` | `agy -p /usage --output-format json` |
| Model | stream `system/init` | app-server `thread/read` | stream `init` |
| Reasoning effort | not reported | app-server `thread/read` | not reported |
| Cost | stream `result` | not reported | not reported |
| Rate-limit retry time | stream `rate_limit_event` | not reported | not reported |

Claude's usage endpoint is undocumented and read with the CLI's stored OAuth
token (`server/usage.ts`). The other two meters come from the CLIs themselves.

## Some mechanisms are shared by all flows

**In-task self-management.** The daemon injects `LANDER_API`, `LANDER_PROJECT`,
`LANDER_TASK`, `LANDER_TOKEN`, and a `PATH` that finds `bin/lander`. Claude and
Antigravity pre-approve `lander` (`Bash(lander:*)`, `command(lander)`). Codex's
shell-environment config passes `LANDER_*` and `PATH` through to its shells
without putting the token in argv.

**Task instructions.** Only Claude has a request-scoped channel for lander's own
prose: `--append-system-prompt` is rebuilt every invocation, so one copy rides
every request. Codex and Antigravity get the task-management instructions in the
user message, and a message sent on one turn is replayed on every later one. So
those flows deliver the template once per thread and deliver it again only when
its rendered text changes. The record of delivery is a content digest in
`flowState.taskPrompt`, written only after a turn produces output, which proves
the model consumed it. Every failure therefore produces a duplicate copy, never a
missing one, and the gate also fires whenever no thread id is recorded. A
project's `LANDER.md` uses the same channel under `flowState.landerDoc`. Claude
needs no record, because its copy is request-scoped. Sharing one gate across
providers would bring back a suppression bug: Claude writes its session id
before the spawn, while Codex learns its thread id from the stream.

**Flow selection.** A task runs the flow it was created with: the new-task form's
pick, `lander launch --flow <name>`, or its parent's flow when `--flow` is
omitted. Lander resolves the flow from `flow`, then the legacy
`agent: "claude" | "codex"` field, then `claude`. `lander relaunch --flow <name>`
moves a task to another flow. That resets the provider session and drops the
task's allow rules, `flowConfig`, and recorded cwd, which were written for the
old flow. Each ride records its flow.

**One-shot helpers.** `lander assist` and the flow API's `assist` use
`claude -p`, `codex exec`, or `agy -p`, chosen by the calling task's flow, which
the server resolves onto the turn's environment. A call without a supported
provider fails instead of picking a default. Each is clamped read-only by its
CLI's own mechanism: `--disallowedTools Bash,Edit,Write,NotebookEdit` for Claude,
`--sandbox read-only` for Codex, and the `lander-assist-readonly` project config
for Antigravity. Task titles are generated by Claude Haiku
whatever the task's flow.

**Usage panel.** The daemon owns the refresh schedule for each flow that sets
`usageSnapshot`: a 60-second floor, a refresh after each turn, a fetch on
connect, and a timer for just after the soonest window resets. The flow's
`onStatus` hook owns the content (`daemon/index.ts`, "Usage").

## Claude

Claude is the reference integration; most of lander's UI was built against its
stream. Permission mechanics are in
[docs/architecture.md](architecture.md#permission-mechanics). Its stream
supplies authoritative permission-denial ids, sub-agent parent ids, the model,
cost, and `rate_limit_event` reset times, which lander turns into a scheduled
retry when a limit ends a turn.

## Codex

The Codex flow launches
`codex exec --json --skip-git-repo-check <config> --cd <dir> -- <prompt>` and
resumes with `… --cd <dir> resume <thread id> -- <prompt>`, where `<config>` is
the permission profile and shell-environment settings below.
`--skip-git-repo-check` lets a project that is not a git repo run at all, since
codex otherwise refuses any directory outside a trusted repo. `<dir>` is the
task's checkout or project root, as for Claude. A
deployment can add a profile and config lines with `LANDER_CODEX_PROFILE` and
`LANDER_CODEX_CONFIG`.

**Permissions.** Every turn runs under the `lander-edit` permission profile,
which extends Codex's built-in `:workspace` profile. It pins the workspace to the
task's checkout or project root, changes the workspace's `.git` rule from read
to write, and grants the repository's Git common directory and, in a linked
worktree, that worktree's own git directory. Granting the common directory alone
left branch switches failing on `.git/worktrees/<id>/HEAD.lock` (codex 0.159.2),
even though that directory is inside it. Otherwise the profile keeps
workspace-write behavior: reads are unrestricted, writes are limited to the
workspace, its git directories, `/tmp`, and `$TMPDIR`, and network access is on.
Codex runs emit no blocked-permission prompts and honor no allow rules, so
`grants` is `{ task: false, project: false }` and the UI hides grant controls.
There is no separate git gate.

**Usage.** `turn.completed` reports the thread's running token total, not the
turn's own: `exec resume` seeds the total from the session (confirmed v0.154.0).
The flow saves each turn's total in `flowState.threadUsage` and charges the turn
the difference from the previous one. A fresh thread starts from zero, and a
total that went down counts in full as a restarted count. A thread resumed
before any total was saved has no baseline, so that one turn gets no usage
instead of being charged the thread's whole history again. When the turn's usage
arrives, the flow asks the app-server's `thread/read` for the model and
reasoning effort most recently saved with the thread and stamps them on the
turn, which can hold up the end of the turn for up to 10 seconds. Codex reports no dollar cost.

**Limits.** The usage panel reads the app-server's `account/rateLimits/read`.
On a ChatGPT plan its `primary` window has been the 5-hour one and `secondary`
the weekly one (0.166.0). A turn that hits a
limit fails with codex's own message (for example "Your workspace is out of
credits"), and lander offers the generic retry without a scheduled time.

**Stream coverage.** The reducer handles text replies, command executions, file
changes, web searches, MCP calls, sub-agent waits, failed commands and turns,
and token usage. Chips are named by the stream item's `type`
(`command_execution`, `file_change`, `web_search`, `mcp_tool_call`,
`collab_tool_call`, `error`), and the input carries whatever else the item says:
an MCP call's server and tool, or a sub-agent call's `tool` and prompt. An
`error` item is a non-fatal notice (a config warning, deprecation, or model
reroute) and doesn't count as the model having consumed the turn. The reducer
reads only the fields of Codex's `exec_events.rs` schema.

`exec --json` omits several things that Codex records elsewhere:

- **Sub-agents.** As of 0.154.0 the only item is a `collab_tool_call` for each
  `wait`, with its receivers and agent states empty. `spawn_agent`,
  `send_message`, and the sub-agents' own activity emit nothing, so a Codex task
  shows when it waited on sub-agents but not which ones or what they did.
- **Denied tool calls.** A shell call refused by the sandbox can return its error
  only inside the enclosing custom-tool result, without the
  `command_execution` item that ordinary failures emit. Neither the chip nor
  errors like `Operation not permitted` reach the task UI.
- **Compaction.** No documented event marks it.
- **Model-facing tool names.** `exec_command`, `apply_patch`, and the like
  appear only in the rollout log.

The app-server protocol has thread items for sub-agent activity and compaction,
sent live to the client running the turn and readable afterward through
`thread/read`. Lander reads neither yet.

**Images.** Attached images are listed by local path in the turn's attachment
manifest, and Codex opens them with `view_image` when needed. Lander passes no
`--image`.

**Hooks.** Codex has a hooks system, but lander doesn't use it. Claude still has
a Stop hook for cwd recording.

## Antigravity

The Antigravity flow runs `agy -p <message> --output-format stream-json
--print-timeout 0s --mode accept-edits --project <id>`, adding
`--conversation <id>` to resume and `--add-dir` for the scratch roots and the
attachment store. `--project` names a lander-managed project config,
`~/.gemini/config/projects/lander-<hash>.json`, where project-scope grants
land through the flow's `onGrant` hook. agy has no per-task rule channel.

agy ends its turn at a call no rule covers instead of letting the agent continue
without it. The flow passes `--log-file` so it can tell which call was refused,
including a sub-agent's, then resumes the same conversation in the same ride with
a message naming the refusals so the agent can choose what to do next.
Usage is cumulative across a conversation and is differenced per turn as for
Codex. A `checkpoint` step is agy's context compaction, shown as a context item.
