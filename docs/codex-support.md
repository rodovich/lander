# Codex support

Lander hosts multiple local coding-agent CLIs through a provider adapter layer.
Codex is intended as a first-class target; tasks runs through Codex when Codex
is selected in the UI, when it is launched with `lander launch --flow codex`,
or when `LANDER_FLOW=codex` sets the instance default.

## Multi-agent architecture

Lander stores the chosen provider on each task as `agent: "claude" | "codex"`.
Existing tasks without an `agent` are treated as Claude tasks. A task keeps using
the provider it was created with; switching providers requires creating a new
task. Relaunching a task resets its provider session while keeping the same
stored provider.

The API server owns task JSON, scheduling, queues, status changes, permission
metadata, and UI-facing state. It does not spawn the agent CLI directly. For each
turn it sends a provider-neutral `start-run` message to the host daemon over the
daemon WebSocket. That message contains the project slug, prompt, stored provider
session id when one exists, permission flags, cwd/worktree hints, and the
`LANDER_*` environment needed by in-task `lander` commands.

The host daemon owns local process execution. It maps project slugs back to host
paths, resolves the launch cwd, selects the provider adapter, builds provider
argv, starts the child process, reduces streamed output, enforces the idle
timeout, and keeps a short replay buffer so a restarted API process can reattach
without rerunning the turn.

The Claude adapter launches `claude` with Claude-specific session, permission,
hook, worktree, and stream-json options. The Codex adapter launches
`codex exec --json --cd <cwd>`, captures the emitted thread id as the provider
session id, and resumes with `codex exec --json --cd <cwd> resume <session-id>`.
Both adapters reduce provider output into Lander's normalized update shape:
activity steps, final assistant text, usage, terminal errors, and provider
session announcements.

In-task self-management is shared. The daemon injects `LANDER_API`,
`LANDER_PROJECT`, `LANDER_TASK`, `LANDER_TOKEN`, and a `PATH` that finds
`bin/lander`. The adapter passes Codex config overrides so `LANDER_*` and `PATH`
are visible to shell commands without putting the task token in argv.

Codex receives the task-management instructions in the user message, because it
has no request-scoped channel for lander's own prose — Claude's
`--append-system-prompt` is rebuilt every invocation, so one copy rides every
request and is replaced when it changes, and Codex has no equivalent. A message
put in front of one Codex turn stays in that turn's message and is replayed on
every later one, so the flow delivers the template **once per thread** and
re-delivers it only when the rendered text changes.

The project's optional `LANDER.md` rides the same channel, under its own key
`flowState.landerDoc`, for the same reason. Claude does not need the record —
there it is appended to `--append-system-prompt`, which is request-scoped, so one
copy is present on every request with nothing to track. That asymmetry is
deliberate: sharing one gate across both providers reinstates a suppression bug,
because Claude writes its session id before the spawn while Codex learns its
thread id from the stream.

The record of that delivery is a content digest in `flowState.taskPrompt`, written
only after a turn produces output — proof the model consumed the turn, and
therefore that the thread holds it. Two consequences worth knowing: a template
edit or a mid-task grant flip re-renders, re-digests, and re-delivers on the next
turn, so live threads do not go stale; and every failure direction is a duplicate
copy rather than a suppressed one, which is why the gate also fires whenever no
thread id is recorded.

`lander assist` and the flow API are provider-aware one-shot helpers. They use
`claude -p` for Claude and `codex exec` for Codex based on the same provider
default.

## Current Codex coverage

Codex tasks can be created from the new-task form or selected as the default with
`LANDER_AGENT=codex`. The server persists that provider choice on the task and
uses it for follow-up turns.

The Codex adapter supports first turns and resumed turns, including explicit
`--cd` handling so resumed Codex turns launch from the daemon-resolved cwd. It
maps Lander's edit flag to named Codex permission profiles:

- `allowEdits=false` extends Codex's built-in `:read-only` profile.
- `allowEdits=true` extends Codex's built-in `:workspace` profile and changes
  the workspace's `.git` rule from read to write. The daemon also resolves and
  grants the Git common directory so linked worktrees can update their shared
  index, objects, and refs.

The editable profile otherwise preserves Codex's workspace-write semantics:
filesystem reads are unrestricted, writes are limited to the workspace, its
resolved Git common directory, `/tmp`, and `$TMPDIR`, and the usual `.agents`
and `.codex` metadata protections remain in place. Both profiles allow network
access, including the local Lander API used by in-task self-management commands.

The Codex JSONL reducer currently handles text replies, command executions, file
change events, failed commands or failed turns, resumed sessions, and per-turn
token usage. The UI can show Codex as the task agent, display Codex turn
activity, show Codex token usage, and label missing cost data as unavailable for
Codex.

Codex tasks can call back into Lander with `lander land`, `lander wedge`,
`lander rest`, `lander launch`, `lander send`, and related commands when the
Codex shell environment receives the injected `LANDER_*` values.

## Current limitations

Codex is not at Claude feature parity. Some differences are due to limitations of
the harness, while others are unfinished work that a different design could
remove.

Permission grants are coarse. Lander selects a read-only or editable Codex
permission profile, but Codex runs do not honor task allow rules or Claude-style
per-tool `--allowedTools`. The UI stores Codex task rules for future parity and
returns a warning, but those rules do not change Codex argv or runtime behavior.
There is also no separate git gate on Codex: edit access includes writes to the
repository's Git metadata so Git runs as an ordinary shell command. It cannot be
narrowed the way a Claude project's `.claude` settings narrow git.

Project permission grants are unsupported for Codex. A project-scope grant for a
Codex task is routed to the daemon, and the Codex adapter reports that project
permission grants are not supported yet.

Codex worktree integration is cwd-based only. Lander can keep provider-neutral
cwd/worktree metadata on the task, and the Codex adapter passes the resolved cwd
with `--cd`. When that cwd is already in a linked Git worktree, the adapter
grants its resolved Git common directory to the edit profile. Codex still does
not use Claude's `--worktree` flag, `.claude/worktrees` session convention, or
EnterWorktree/ExitWorktree hook flow.

Codex hooks are not wired into Lander. Claude still has provider-specific hooks
for background-shell advisory context, cwd recording, and worktree bookkeeping.
Codex currently relies on explicit launch cwd, prompt instructions, permission
profiles, and environment config rather than equivalent per-turn hooks.

Codex usage data is per-turn only. Lander can parse token usage from Codex JSONL,
but Codex tasks do not have Claude-style subscription-window usage, cost
reporting, or reliable rate-limit reset scheduling in the current integration.

Codex stream data is less rich than Claude's stream for some UI features. The
current reducer handles the common event shapes Lander has fixtures for, but it
does not provide all Claude-specific fields such as authoritative permission
denial ids, Claude subagent parent metadata, Claude model/cost data, or
subscription reset events.

Codex's `exec --json` stream does not export dynamic/custom tool-call items.
Most shell activity still appears because a nested shell invocation emits a
separate `command_execution` item. However, a shell invocation denied by the
sandbox can return its error only as the enclosing custom-tool result without
emitting that `command_execution`. Codex records the call and result in its
private rollout log, but Lander intentionally consumes only the public JSONL
stream, so neither the tool chip nor errors such as `Operation not permitted`
appear in the task UI. Ordinary nonzero `command_execution` results are not
affected and remain visible as failed tools.

Task auto-title generation still uses the Claude Haiku helper independently of
the task's selected provider. A Codex task can run through Codex while its
background title may still be generated by Claude.
