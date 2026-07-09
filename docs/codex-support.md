# Codex support

Lander supports multiple local coding-agent CLIs through a provider adapter layer.
Claude remains the default provider, but new tasks can run through Codex when
selected in the UI or when `LANDER_AGENT=codex` sets the default.

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
`bin/lander`. Codex receives the task-management instructions as part of the
prompt, and the adapter passes Codex config overrides so `LANDER_*` and `PATH`
are visible to shell commands without putting the task token in argv.

`lander assist` and the flow API are provider-aware one-shot helpers. They use
`claude -p` for Claude and `codex exec` for Codex based on the same provider
default.

## Current Codex coverage

Codex tasks can be created from the new-task form or selected as the default with
`LANDER_AGENT=codex`. The server persists that provider choice on the task and
uses it for follow-up turns.

The Codex adapter supports first turns and resumed turns, including explicit
`--cd` handling so resumed Codex turns launch from the daemon-resolved cwd. It
maps Lander's edit flag to Codex sandboxing:

- `allowEdits=false` uses read-only execution.
- `allowEdits=true` uses workspace-write execution.

The Codex JSONL reducer currently handles text replies, command executions, file
change events, failed commands or failed turns, sandbox-denial messages, resumed
sessions, and per-turn token usage. The UI can show Codex as the task agent,
display Codex turn activity, show Codex token usage, and label missing cost data
as unavailable for Codex.

Codex tasks can call back into Lander with `lander land`, `lander wedge`,
`lander rest`, `lander launch`, `lander send`, and related commands when the
Codex shell environment receives the injected `LANDER_*` values.

## Current limitations

Codex support is useful for basic task execution and resume, but it is not at
Claude feature parity.

Permission grants are coarse. Lander maps edit access to Codex sandbox modes, but
Codex runs do not honor task allow rules or Claude-style per-tool
`--allowedTools`. The UI stores Codex task rules for future parity and returns a
warning, but those rules do not change Codex argv or runtime behavior. There is
also no separate git gate on Codex: `read-only` blocks all writes, while
`workspace-write` (edit access) lets a turn run git as an ordinary shell command
— it can't be narrowed the way a Claude project's `.claude` settings narrow git.

Project permission grants are unsupported for Codex. A project-scope grant for a
Codex task is routed to the daemon, and the Codex adapter reports that project
permission grants are not supported yet.

Codex worktree integration is cwd-based only. Lander can keep provider-neutral
cwd/worktree metadata on the task, and the Codex adapter passes the resolved cwd
with `--cd`, but Codex does not use Claude's `--worktree` flag,
`.claude/worktrees` session convention, or EnterWorktree/ExitWorktree hook flow.

Codex hooks are not wired into Lander. Claude still has provider-specific hooks
for background-shell advisory context, cwd recording, and worktree bookkeeping.
Codex currently relies on explicit launch cwd, prompt instructions, sandboxing,
and environment config rather than equivalent per-turn hooks.

Codex usage data is per-turn only. Lander can parse token usage from Codex JSONL,
but Codex tasks do not have Claude-style subscription-window usage, cost
reporting, or reliable rate-limit reset scheduling in the current integration.

Codex stream data is less rich than Claude's stream for some UI features. The
current reducer handles the common event shapes Lander has fixtures for, but it
does not provide all Claude-specific fields such as authoritative permission
denial ids, Claude subagent parent metadata, Claude model/cost data, or
subscription reset events.

Task auto-title generation still uses the Claude Haiku helper independently of
the task's selected provider. A Codex task can run through Codex while its
background title may still be generated by Claude.
