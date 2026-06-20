# lander

A web UI for spawning and chatting with **Claude Code agents** against a target project directory. Each "task" is a persistent `claude -p` session running in your codebase.

## What it does

- You create a **task** (title + initial message) in a browser UI.
- The server launches `claude` as a CLI subprocess **in the target project directory**, passing your message as the prompt.
- Claude's stdout is captured and appended back to the task as an assistant reply.
- You can keep **replying** in a task; follow-up turns resume the same Claude session, so context is preserved across the conversation.
- Activity streams into the task as it happens; the UI polls every 2s, so steps and the final reply surface within a couple seconds.

## Usage

```sh
npm install
npm run dev /path/to/project [/path/to/another ...]
```

Type-check with `npm run typecheck`.

Each path is resolved and the list is exported as `PROJECT_DIRS` (newline-separated); these are the working directories where `claude` runs. Then open the web UI on port 41414.

Each project gets a URL slug from its path (e.g. `/Users/me/code/app` → `users-me-code-app`). The sidebar shows a dropdown to switch projects; choosing one pushes its slug into the URL (`/users-me-code-app/`). Visiting `/` redirects to the first project passed on the command line.

## Architecture

**Two processes**, launched together by `dev.mjs` via `concurrently`:

| Part | Stack | Port | Role |
|------|-------|------|------|
| Web | React 18 + Vite | 41414 | SPA, proxies `/api` → 6181 |
| API | Hono on `@hono/node-server` | 6181 | Task CRUD + drives the `claude` CLI |

### API (`server/index.ts`)

- `GET /api/projects` — list the configured projects (`{ path, slug }`); the first is the default.
- `GET /api/:project/tasks` — list a project's tasks (sorted newest-first). `?archived=1` also merges in archived tasks, each tagged `archived: true`.
- `POST /api/:project/tasks` — create a task; fires off `claude --session-id <uuid> -p <msg>` (fire-and-forget).
- `POST /api/:project/tasks/:id/messages` — append a user message; continues via `claude --resume <uuid> -p <msg>`.
- `POST /api/:project/tasks/:id/allow` — grant a permission rule the agent was blocked on. `{ rule, scope }`: `scope: "task"` appends `rule` to the task's `allow` list (fed to `--allowedTools` on future turns); `scope: "project"` writes it to the project's `.claude/settings.local.json`. Human-only (see [Authenticated permission grants](#authenticated-permission-grants)).
- `POST /api/:project/tasks/:id/archive` — `{ archived }` (default `true`) moves the task's JSON between `tasks/` and `archived/`. Archiving takes a task out of the list (and out of the scheduler's and recovery's view, which only scan `tasks/`); `{ archived: false }` restores it. A `riding` task can't be archived — it has a live run the reducer must keep reattaching to — so the call `409`s until it comes to rest.

All task routes are scoped by the project slug, which selects the working directory `claude` runs in and the on-disk data dir.
- A turn doesn't run as a child of the server. The server writes a **job spec** and launches a **detached `lander run` process** that outlives it (its own process group, `unref`'d). That runner owns the `claude` child, appends its raw `stream-json` to a per-run **append-only log**, and records liveness (`lease.json`, refreshed on a ~5s heartbeat) and completion (`done.json`) — enforcing the 10-min **idle** timeout (reset on each chunk, so a still-streaming turn isn't killed). The server only ever *reads* those files: `reduceRun()` tails the log from a byte cursor persisted on the task, folding each line into steps via the shared `reduceStreamLine` reducer; a non-zero exit with no reply is surfaced as an error message.
- Because the runner survives a server restart, an in-flight turn keeps going across a reload and a fresh process **reattaches** to it (resuming the reduce from the persisted cursor — see [Restart & hot reload](#restart--hot-reload)). The server stays the **sole writer of task JSON**; the runner only writes its own run files, so the two could later run on separate hosts.

### Storage

Flat JSON files, one per task, no database. Tasks live under `./data/<normalized-project-path>/tasks/<uuid>.json`, where the project path is slugified (e.g. `/Users/me/code/app` → `Users-me-code-app`). This namespaces tasks per target project. The task `id` doubles as the Claude `--session-id`. Alongside `tasks/` is `runs/<runId>/`, one directory per turn holding the runner's job spec, output log, lease, and done marker; the task carries the `runId` (and reduce cursor) of any run currently in flight. Also alongside is `archived/`: archiving a task **moves** its `<uuid>.json` there, which is how an archived task drops out of the list and out of the scheduler/recovery sweeps (both scan only `tasks/`) — its location on disk is the sole source of truth for the archived state, so nothing is written into the file itself.

Each turn builds `--allowedTools` from `Bash(lander:*)` (always), `Edit`/`Write`/`MultiEdit` (if `allowEdits`), `Bash(git:*)` (if `allowCommits`), and the task's `allow` list (rules granted via the "allow in task" popup). Project-scoped grants instead land in the project's `.claude/settings.local.json`, which the CLI reads on its own.

### Restart & hot reload

Because turns run in detached runners (see [API](#api-serverindexts)), restarting the API no longer interrupts in-flight work — so the API runs under `tsx watch` and **hot-reloads on server edits** (including when claude edits `server/index.ts` while lander targets its own repo). Two mechanisms keep a reload clean:

- **Graceful shutdown.** On `SIGTERM`/`SIGINT` the server stops the scheduler and lets the HTTP server finish in-flight requests before exiting (a 3s timeout forces it if a connection won't close), so a reload never drops a write mid-flight.
- **Reattach on boot.** `recoverQueues()` scans each task: one with a tracked `runId` whose runner is still alive (fresh lease) or already finished (`done.json`) is **reattached** — `driveTask` resumes reducing its log from the persisted cursor, so no output is lost and the agent is never re-run. Only a run whose runner truly died without finishing (stale lease, no `done.json`) is treated as interrupted and **replayed** — pending flags cleared and the turn re-queued (a "Resumed at … after the previous run was interrupted" nudge for one that already replied, or the opening message replayed for one that never did). Tasks with leftover `queued` messages are drained the same way.

### Self-management (`bin/lander`)

A task's agent can call back into lander to manage itself. When the server launches a turn, the runner injects `LANDER_API`, `LANDER_PROJECT`, `LANDER_TASK`, and `LANDER_TOKEN` (a per-task secret) into claude's environment, prepends `bin/` to `PATH`, pre-approves `Bash(lander:*)`, and appends a system-prompt note describing the commands. So inside any task the agent can run:

| Command | Effect |
|---------|--------|
| `lander land` | Mark **this** task `landed` (shorthand for `status landed`). |
| `lander status <status>` | Set this task's status to any string. |
| `lander rest --date <when>` / `--time <minutes>` / `--await <ids>` | Put **this** task to rest until a wakeup trigger fires (a time, or other tasks landing); it resumes then with a generated "Resumed at …" message. |
| `lander launch <message>` | Spawn a **sibling** task that runs independently; prints its id. |
| `lander list` | List this project's tasks (id, status, title), newest first. |
| `lander view <id>` | Show one task's status and recent conversation. |
| `lander send <id> <message>` | Message another task in this project — now, or deferred with `--date`/`--time`/`--await`. |
| `lander archive <id> [--restore]` | Archive a task (or `--restore` it) — move it out of the list into `archived/`, or back. |

`land`, `status`, and `rest` act on the current task via `LANDER_TASK`; `launch`, `list`, `view`, `send`, and `archive` only need `LANDER_API`/`LANDER_PROJECT`. `list`, `view`, `send`, and `archive` are scoped to the caller's own project: `list` accepts `--status <s>` to filter and `--json` for the raw task array; `view` takes a full id or any unambiguous short-id prefix (as printed by `list`) and accepts `--json` for the full task; `send` likewise resolves a prefix, reads its message from the argument or stdin (`-`), and leads the delivered message with a `✉ From [sender](…)` backlink to the sending task (mirroring `launch`'s spawn backlink). `archive` resolves a prefix too — among active tasks to archive, among archived ones with `--restore` — and POSTs to the archive endpoint. With no trigger flag `send` delivers immediately — queued behind any in-flight turn, exactly like a reply from the UI; with `--date`/`--time`/`--await` (same semantics as `launch`/`rest`) it stashes the message on the recipient as a `scheduledMessages` entry — carrying a `deliverAt` time and/or a `waitFor` condition — that the same scheduler sweep delivers when its trigger fires (the time arrives, or every awaited task lands, whichever first). A task may only message tasks in its own project (the server rejects cross-project sends with 403). `lander launch` reads the message from the argument, or from stdin if it's `-`, and accepts `--project <slug>`, `--title <title>`, `--date <when>` / `--time <minutes>` / `--await <ids>`, `--edits`, and `--commits`. `--title` names the task directly (a concise 2-5 word title, sentence case, no quotes/punctuation — the same guidance the auto-titler follows) instead of having haiku name it. `--date` and `--time` defer the launch and are mutually exclusive: `--date` is any date/time the server can parse, `--time` a number of minutes from now. `--await <ids>` (comma-separated task ids or unambiguous prefixes, resolved to full ids by the CLI) instead defers the launch until those tasks have **all** landed, and combines with `--date`/`--time` to launch on whichever fires first. A deferred task is created resting with a `scheduled` event — or an `awaiting` event listing the tasks it waits on (the time fallback isn't shown) when `--await` is used — and a scheduler sweep (every 15s, plus once on boot to catch triggers that fired during downtime) runs it once a trigger is met: its time arrives, or every awaited task has landed (a missing one — archived or deleted — counts as landed so a vanished dependency can't strand the waiter), recording a `launched` event at that point. A resting scheduled task also gets a **Launch** item in its row's kebab menu (see [Frontend](#frontend-srcapptsx)) to run it early. `lander rest` takes the same `--date`/`--time`/`--await` flags (at least one required) to re-sleep a running task: it flips to resting with a `scheduled` (or `awaiting`) event and, when the scheduler wakes it, resumes with a generated "Resumed at …" message instead of a fresh opening one. `--edits`/`--commits` are inherit-only: a child may be granted edit/commit access only if the spawning task already has it. The CLI is a zero-dependency Node script that talks to the local HTTP API, so the server stays the single source of truth (e.g. `launch` goes through `POST /tasks`, which also fires off the spawned agent and auto-titles it). The same script has one **internal** subcommand the server (not the agent) invokes — `lander run <jobfile>` — which is the detached turn runner described under [API](#api-serverindexts); it takes everything from the job file and is what actually launches `claude`.

#### Authenticated permission grants

Every request to the local API is unauthenticated by default, so the server distinguishes two **principals** before honoring any permission change, identifying the caller from request headers:

- **The human** — the browser sends a shared UI secret (`X-Lander-UI-Token`). `dev.mjs` mints it once, persists it under `data/.ui-token` (gitignored, mode 0600), inlines it into the client as `VITE_LANDER_UI_TOKEN`, and passes it to the API as `LANDER_UI_TOKEN`. The human may grant anything.
- **A task** — the `lander` CLI sends its `LANDER_TOKEN` plus its task id/project (`X-Lander-Token`/`X-Lander-Task`/`X-Lander-Project`); the server matches the token against the task's stored secret. A task may only pass on permissions it already holds, and **cannot** change its own grants or add tool rules. Tokens are never returned over HTTP, so one task can't read another's to impersonate it.

Concretely, the server enforces:

- `POST /tasks` with `allowEdits`/`allowCommits` — the human may set either; a task may set only those it holds (else `403`); an unidentified caller may set neither.
- `PATCH /tasks/:id` of `allowEdits`/`allowCommits` — human only (a task `403`s, so it can't self-escalate). Status/title stay open so the CLI's `land`/`status` keep working.
- `POST /tasks/:id/allow` — human only.

This is best-effort for a single-user local tool: a fully adversarial task running as the same user could still read `data/.ui-token` off disk. It blocks the realistic failure mode — an agent escalating itself or a child via the documented API — not a determined local attacker.

This makes orchestration patterns possible — e.g. a task that fans out a review per assigned PR:

```sh
gh pr list --search "review-requested:@me" --json number -q '.[].number' |
  while read pr; do lander launch "Review PR #$pr using \`gh pr diff $pr\`."; done
```

So that an agent-set status survives, `driveTask` only resets `riding → resting` on exit — it won't clobber a status like `wedged` or the terminal `landed` the agent set mid-run.

### Frontend (`src/App.tsx`)

Single component: sidebar (task list + new-task form) and a detail pane (message thread + reply composer). Enter submits, Shift/Option+Enter for newlines; shows a "claude is working…" indicator when the last message is from the user.

Each task row carries a **kebab (⋮) menu** with the status actions — **Wedge** / **Rest** / **Land** / **Launch** — plus **Archive**. Only the items that would be both visible *and* enabled for the row's status appear (e.g. a landed task offers Wedge/Rest/Archive but not Land; a riding task can't be archived), so the menu never shows a dead option. The menu is `position: fixed`, anchored to the kebab's live rect, so the scrolling list can't clip it, and arrow keys move between items. Archived tasks are hidden by default; the project dropdown has a **Show archived** toggle that merges them in (each row dimmed and tagged `archived`), where the kebab offers only **Restore**.

Each streamed turn renders its activity trace as steps. A `tool_use` step is a clickable chip; the server pairs it with its `tool_result` (by `tool_use_id`) and flags whether that result was an error and, specifically, a **permission refusal** (`is_error` plus a denial-phrase match). A refused call's chip is red. Clicking any chip opens a popup showing the call as an editable `settings.json`-style rule (e.g. `Bash(npm run build)`) and its status (`allowed`/`blocked`/`pending`); for a blocked call it offers **allow in task** and **allow in project**, which POST the (possibly edited) rule to the allow endpoint. Clicking outside or pressing Escape dismisses it.

## Notable details

- `status` moves through `riding` (agent working) → `resting` (idle) when a turn finishes; an agent can also set its own status — `wedged` (needs the user) or the terminal `landed` — via the `lander` CLI (see Self-management).
- **Archiving** is orthogonal to status: it just relocates a task's JSON to `archived/` so it leaves the list and the scheduler/recovery sweeps. Any non-`riding` task can be archived (from the row's kebab menu or `lander archive`); restoring moves it back. An archived task keeps its status and history untouched.
- Reads are unauthenticated (only permission *changes* check a principal — see Authenticated permission grants); delivery is by 2s polling, not SSE/websockets — though the turn itself streams (see Frontend).
- Task IDs are validated as UUIDs before filesystem access, which guards against path traversal on the `:id` route.
