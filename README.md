# lander

A web UI for spawning and managing coding agents against target project directories. Each "task" is a persistent agent session running in your codebase, currently backed by `claude` or `codex`.

## What it does

- You create a **task** (title + initial message) in a browser UI and choose an agent.
- The host daemon launches `claude` or `codex` as a CLI subprocess **in the target project directory**, passing your message as the prompt.
- The agent's stream is reduced into activity steps and appended back to the task with the assistant reply.
- You can keep **replying** in a task; follow-up turns resume the same provider session, so context is preserved across the conversation.
- Activity streams into the task as it happens; the UI polls every 2s, so steps and the final reply surface within a couple seconds.

## Usage

```sh
npm install
npm run dev /path/to/project [/path/to/another ...]
```

Type-check with `npm run typecheck`. Run the unit tests with `npm test` (or `npm run test:watch` to re-run on change); they cover the pure server-side logic — the agent stream reducers, the task store, and the project-path/status helpers — plus the markdown renderer.

Each path is resolved and the list is exported as `PROJECT_DIRS` (newline-separated); these are the working directories where agent subprocesses run. Then open the web UI on port 41414.

Each project gets a URL slug from its path (e.g. `/Users/me/code/app` → `users-me-code-app`). The sidebar shows a dropdown to switch projects; choosing one pushes its slug into the URL (`/users-me-code-app/`). Visiting `/` redirects to the first project passed on the command line.

## Architecture

**Three processes**, launched together by `dev.mjs` via `concurrently`:

| Part | Stack | Port | Role |
|------|-------|------|------|
| Web | React 18 + Vite | 41414 | SPA, proxies `/api` → 6181 |
| API | Hono on `@hono/node-server` | 6181 | Task CRUD, scheduling, and daemon coordination |
| Daemon | Node host process | — | Owns `claude`/`codex` subprocesses, stream reduction, and Claude usage polling |

### API (`server/index.ts`)

- `GET /api/projects` — list the configured projects (`{ path, slug }`); the first is the default.
- `GET /api/:project/tasks` — list a project's tasks (sorted newest-first). `?archived=1` also merges in archived tasks, each tagged `archived: true`.
- `POST /api/:project/tasks` — create a task, store its chosen agent, and queue the first turn on the daemon.
- `POST /api/:project/tasks/:id/messages` — append a user message; the daemon resumes the task's stored provider session. Both this and `POST .../tasks` accept `attachments: id[]` to associate uploaded files with the message (see [Attachments](#attachments)).
- `POST /api/:project/attachments` — upload one or more files (multipart) to the project's durable blob store, returning their refs (`{id, name, mime, size}`). `GET /api/:project/attachments/:id` streams a stored file's bytes. Both require an identified caller (the browser's UI token or a task's `LANDER_TOKEN`).
- `POST /api/:project/tasks/:id/artifacts` — publish a task's named output file (multipart `file` + optional `name`), latest version only; `GET /api/:project/tasks/:id/artifacts` lists the slots and `GET .../artifacts/:name` streams the current blob. Only the task itself (or the human) may publish; any identified caller may read. See [Artifacts](#artifacts).
- `POST /api/:project/tasks/:id/allow` — grant a permission rule (a denied one from the per-turn blocked summary, or one authored proactively from the header grant control). `{ rule, scope }`: for Claude, `scope: "task"` appends `rule` to the task's `allow` list (fed to `--allowedTools` on future turns) and `scope: "project"` writes it to the project's `.claude/settings.local.json`. Codex task rules are saved for parity but do not affect Codex runs yet, and project grants are not supported for Codex tasks. Human-only (see [Authenticated permission grants](#authenticated-permission-grants)).
- `POST /api/:project/tasks/:id/archive` — `{ archived }` (default `true`) moves the task's JSON between `tasks/` and `archived/`. Archiving takes a task out of the list (and out of the scheduler's and recovery's view, which only scan `tasks/`); `{ archived: false }` restores it. A `riding` task can't be archived — it has a live run the reducer must keep reattaching to — so the call `409`s until it comes to rest.

All task routes are scoped by the project slug, which selects the host working directory the agent runs in and the on-disk data dir.
- A turn doesn't run as a child of the server. The server sends a provider-neutral `start-run` message to the host daemon over WebSocket. The daemon owns the selected `claude` or `codex` child process, reduces its stream into normalized updates, enforces the 10-minute idle timeout, and keeps a short replay buffer for reconnects. The server applies those updates to task JSON and surfaces a non-zero exit with no reply as an error message.
- Because the daemon survives a server restart, an in-flight turn keeps going across a reload and a fresh server **reattaches** to it (resuming from the persisted run cursor — see [Restart & hot reload](#restart--hot-reload)). The server stays the **sole writer of task JSON**; the daemon only owns live process state and replay buffers, so the two can later run on separate hosts.

### Storage

Flat JSON files, one per task, no database. Tasks live under `./data/<normalized-project-path>/tasks/<uuid>.json`, where the project path is slugified (e.g. `/Users/me/code/app` → `Users-me-code-app`). This namespaces tasks per target project. The task `id` belongs to Lander; the provider session id is stored separately as `sessionId` after the daemon reports it. The task carries the `runId` and `runCursor` of any run currently in flight so a reloaded server can reattach to the daemon's live replay buffer. Also alongside is `archived/`: archiving a task **moves** its `<uuid>.json` there, which is how an archived task drops out of the list and out of the scheduler/recovery sweeps (both scan only `tasks/`) — its location on disk is the sole source of truth for the archived state, so nothing is written into the file itself.

Claude turns build `--allowedTools` from `Bash(lander:*)` (always) and the task's `allow` list (rules granted in **task** scope from the per-turn blocked-permissions summary). Edit access rides `--permission-mode acceptEdits` instead of the allowlist, plus `--add-dir` for the scratch roots (`/tmp` and `os.tmpdir()` — the same path on Linux, but distinct on macOS, where `os.tmpdir()` resolves `$TMPDIR` to a per-user `/var/folders/<hash>/T`). Naming `Edit`/`Write` in `--allowedTools` is "explicit permission", which escapes the working-directory boundary — a granted `Write` can create `/tmp/anything`; `acceptEdits` instead auto-approves file edits and the filesystem Bash commands (`mkdir`/`touch`/`rm`/`rmdir`/`mv`/`cp`/`sed`) and `>` redirects only for paths under the cwd, the scratch roots, or the attachment `--add-dir` root, and never for protected paths (`.git`, `.claude`, shell rc files) — so it both bounds edits and gives edit-capable tasks the delete access a bare `Edit`/`Write` grant can't express. It widens nothing else: git and every other Bash command follow the project's normal `.claude` settings (`settings.json` / `settings.local.json`) plus per-task allow rules — anything unlisted is denied in headless mode. To let tasks run git in a project, add a rule like `Bash(git:*)` to that project's `.claude/settings.json`. Project-scoped Claude grants (granting a denied rule in **project** scope) land in `.claude/settings.local.json`, which the CLI reads on its own. Codex turns use named permission profiles: read-only tasks extend Codex's built-in read-only profile, while editable tasks extend its workspace profile and add write access to the workspace's `.git` path and resolved Git common directory. The editable profile otherwise preserves workspace-write behavior, including general filesystem reads and writes to `/tmp` and `$TMPDIR`. Task allow rules are stored by Lander but do not affect Codex runs yet, and Codex has no separate git gate inside an editable task.

### Restart & hot reload

Because turns run in the separate host daemon (see [API](#api-serverindexts)), restarting the API no longer interrupts in-flight work — so the API runs under `tsx watch` and **hot-reloads on server edits** (including when an agent edits `server/index.ts` while lander targets its own repo). Two mechanisms keep a reload clean:

- **Graceful shutdown.** On `SIGTERM`/`SIGINT` the server stops the scheduler and lets the HTTP server finish in-flight requests before exiting (a 3s timeout forces it if a connection won't close), so a reload never drops a write mid-flight.
- **Reattach on boot.** `recoverQueues()` scans each task: one with a tracked `runId` is **reattached** by asking the daemon to replay updates after the persisted cursor, so no output is lost and the agent is never re-run. Only a run no connected daemon still owns after the reconnect grace is treated as interrupted and **replayed** — pending flags cleared and the turn re-queued (a "Resumed at … after the previous run was interrupted" nudge for one that already replied, or the opening message replayed for one that never did). Tasks with leftover `queued` messages are drained the same way.

### Self-management (`bin/lander`)

A task's agent can call back into lander to manage itself. When the daemon launches a turn, it injects `LANDER_API`, `LANDER_PROJECT`, `LANDER_TASK`, and `LANDER_TOKEN` (a per-task secret) into the agent environment, prepends `bin/` to `PATH`, and includes task-management instructions in the prompt. Claude also gets `Bash(lander:*)` pre-approved. So inside any task the agent can run:

| Command | Effect |
|---------|--------|
| `lander land` | Mark **this** task `landed`. |
| `lander wedge [--option id:label]...` | Mark **this** task `wedged` — it's blocked and needs the user. Repeatable `--option id:label` raises a choice ask whose buttons render under your message (your message is the question); the chosen option's label arrives as the next user message. |
| `lander ask --option id:label...` | Raise an **advisory** choice question on **this** task *without* wedging — the task keeps resting and nothing appears in the list. The option buttons render under your message and the chosen option's label arrives as the next user message. The user may instead just reply, which supersedes the ask. (Choice-only: a free-text ask would just duplicate the composer.) |
| `lander rest --date <when>` / `--time <minutes>` / `--await <ids>` | Put **this** task to rest until a wakeup trigger fires (a time, or other tasks landing); it resumes then with a generated "Resumed at …" message. |
| `lander rest --clear` | Drop **this** task's pending wakeup triggers (the time/await a prior `rest` armed) — for when it was woken early and the scheduled resume is no longer wanted. |
| `lander launch <message>` | Spawn a **sibling** task that runs independently; prints its id. |
| `lander list [--since/--until <when>] [--text <terms>]` | List this project's tasks (id, status, title, created/updated timestamps), newest first; optionally bounded to a createdAt range and/or filtered by title/message text. |
| `lander view <id>` | Show one task's status and recent conversation. |
| `lander send <id> <message>` | Message another task in this project — now, or deferred with `--date`/`--time`/`--await`. |
| `lander archive <id> [--restore]` | Archive a task (or `--restore` it) — move it out of the list into `archived/`, or back. |
| `lander file ls` / `lander file cat <id>` | List **this** task's attachments (id/name/mime/size) or stream one's raw bytes to stdout — see [Attachments](#attachments). |
| `lander artifact put <path> [--name <n>] [--mime <m>]` / `lander artifact ls` / `lander artifact cat <name>` | Publish **this** task's named output file (name defaults to the basename), list its output slots, or stream a slot's current blob to stdout — see [Artifacts](#artifacts). |

`land`, `wedge`, and `rest` act on the current task via `LANDER_TASK`; `launch`, `list`, `view`, `send`, and `archive` only need `LANDER_API`/`LANDER_PROJECT`. `list`, `view`, `send`, and `archive` are scoped to the caller's own project: `list` accepts `--status <s>` to filter, `--since`/`--until <when>` to bound the range by createdAt, `--text <terms>` to search title and message text (a term equal to a task's exact id also matches), and `--json` for structured metadata. In all cases `list` returns metadata only, never task conversations. `view` takes a full id or unambiguous prefix and accepts `--json` for the full task. `send` resolves a prefix, reads its message from the argument or stdin (`-`), and leads the delivered message with a bare `From <sender id>:` backlink to the sending task.

With no trigger flag, `send` delivers immediately, queued behind any in-flight turn. With `--date`/`--time`/`--await` (same semantics as `launch`/`rest`) it stashes the message on the recipient as a scheduled message that fires when its time arrives or every awaited task has landed, whichever comes first. A task may only message tasks in its own project.

`lander launch` reads the message from the argument, or from stdin if it's `-`, and accepts `--project <slug>`, `--title <title>`, `--date <when>` / `--time <minutes>` / `--await <ids>`, and `--edits`. `--title` names the task directly instead of using the auto-titler. Deferred launches are created resting and the scheduler wakes them when their trigger fires; a resting scheduled task also gets a **Launch** item in its row's kebab menu (see [Frontend](#frontend-srcapptsx)) to run it early. A spawned task is read-only unless `--edits` is passed, and `--edits` is inherit-only: a child may be granted edit access only if the spawning task already has it. (Git isn't a Lander grant — it's governed by the project's `.claude` settings.) A human can later grant edits to a read-only task from the crossed-out-pencil menu in the task header.

`lander rest` takes the same `--date`/`--time`/`--await` flags (at least one required) to re-sleep a running task: it flips to resting with a scheduled or awaiting event and, when the scheduler wakes it, resumes with a generated "Resumed at …" message. `lander rest --clear` disarms pending wakeup triggers without touching status or rewriting history. The CLI is a zero-dependency Node script that talks to the local HTTP API, so the server stays the single source of truth; actual agent subprocesses are launched by the daemon, not by the CLI.

#### Attachments

Messages can carry file/image attachments, propagated to both Claude and Codex agents. From the web UI, a **paperclip** below the new-task and reply composers attaches files; from the CLI, `lander launch` and `lander send` take `--files <paths…>` (variadic — put it last, after the message, since it consumes following args up to the next `--flag`). Attachments are uploaded to a durable per-project blob store (`data/<project>/attachments/`, an `<id>` blob plus an `<id>.json` metadata sidecar) and carried on the message as refs (`{id, name, mime, size}`) — never inlined into the prompt.

At turn time the daemon lazily materializes a task's attachments into a per-task dir on its host (`LANDER_FILES_DIR`, cached across turns), writes a `manifest.json`, and appends a small **manifest block** (ids/names/sizes, never the bytes) to the outgoing prompt. Images additionally reach the model's **vision**: Codex via `--image`, Claude via `Read` on the local path (the daemon grants `--add-dir` for the store dir so Read can reach it). To read any attached file's bytes an agent runs `lander file cat <id>` (a pure local read of `$LANDER_FILES_DIR/<id>` — no server call, no sandbox widening), and `lander file ls` lists the current task's attachments with sizes.

#### Artifacts

Where attachments are message **inputs**, artifacts are a task's **outputs**: named files a task publishes as it works. An artifact is a named slot on the task holding only its latest version — publishing to the same name mints a fresh blob, repoints the slot, and deletes the superseded blob (only after the task write commits, so a crash strands an orphan blob rather than a dangling ref). The blobs reuse the same durable per-project store as attachments (`data/<project>/attachments/`), with a separate 100 MiB cap. Names are addressable (route segment + download filename) so they're validated strictly (`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$` — no leading dot, no slash).

An agent publishes with `lander artifact put <path> [--name <n>] [--mime <m>]` (name defaults to the file's basename), lists its slots with `lander artifact ls`, and reads a slot's current bytes with `lander artifact cat <name>` — all scoped to the current task, which may publish only its own outputs. Each publish records a ref on the assistant message that generated it (the in-flight message when mid-turn, else the last assistant message), and the web UI renders those as **download rows at the bottom of that message**. Downloads resolve by slot name and always serve the latest version, so an older message's ref pointing at a superseded blob is harmless.

#### Authenticated permission grants

Every request to the local API is unauthenticated by default, so the server distinguishes two **principals** before honoring any permission change, identifying the caller from request headers:

- **The human** — the browser sends a shared UI secret (`X-Lander-UI-Token`). `dev.mjs` mints it once, persists it under `data/.ui-token` (gitignored, mode 0600), inlines it into the client as `VITE_LANDER_UI_TOKEN`, and passes it to the API as `LANDER_UI_TOKEN`. The human may grant anything.
- **A task** — the `lander` CLI sends its `LANDER_TOKEN` plus its task id/project (`X-Lander-Token`/`X-Lander-Task`/`X-Lander-Project`); the server matches the token against the task's stored secret. A task may only pass on permissions it already holds, and **cannot** change its own grants or add tool rules. Tokens are never returned over HTTP, so one task can't read another's to impersonate it.

Concretely, the server enforces:

- `POST /tasks` with `allowEdits` — the human may grant it; a task may grant it only if it holds edits itself (else `403`); an unidentified caller may not. The UI always launches human-started tasks with `allowEdits: true`.
- `PATCH /tasks/:id` of `allowEdits` — human only (a task `403`s, so it can't self-escalate). Status/title stay open so the CLI's `land`/`status` keep working.
- `POST /tasks/:id/allow` — human only.

This is best-effort for a single-user local tool: a fully adversarial task running as the same user could still read `data/.ui-token` off disk. It blocks the realistic failure mode — an agent escalating itself or a child via the documented API — not a determined local attacker.

This makes orchestration patterns possible — e.g. a task that fans out a review per assigned PR:

```sh
gh pr list --search "review-requested:@me" --json number -q '.[].number' |
  while read pr; do lander launch "Review PR #$pr using \`gh pr diff $pr\`."; done
```

So that an agent-set status survives, `driveTask` only resets `riding → resting` on exit — it won't clobber a status like `wedged` or the terminal `landed` the agent set mid-run.

### Flows (`lander flow`)

A **flow** is a reusable script stored as `data/<normalized-project-path>/flows/<name>.js` (a sibling of the project's `tasks/` dir) that exports a default async function. A task runs one with `lander flow <name> [--key value …]`; the `--key value` pairs arrive as the flow's `lander.inputs`.

The server only **resolves** the script's path (`GET /api/:project/flows/:name`, guarded against path traversal); the CLI **imports it in-process** and calls its default export with a `lander` object — keeping the server the source of truth for where flows live without taking on execution. Because the flow runs inside the CLI's own Node process, control flow (conditionals, loops, retries, waiting) is just JavaScript, and the same `lander` object exposes the self-management surface as awaitable methods:

| Method | Backed by |
|--------|-----------|
| `lander.inputs` | the `--key value` flags, as an object |
| `await lander.launch(message, { project, title, date, time, await, edits })` | `POST /tasks`; returns the new task's id |
| `await lander.send(target, message, { date, time, await })` | message another task (id or unambiguous prefix) |
| `await lander.view(target)` | returns the **parsed task object** (`.status`, `.title`, `.messages`, …) — not text to re-parse |
| `await lander.list({ status })` | the project's tasks as an array |
| `lander.land()` / `lander.wedge({ options })` / `lander.ask({ options })` / `await lander.rest({ date, time, await })` | act on the current task — bare `wedge()` just sets status, or pass `{ options: [{ id, label }] }` to raise a choice ask whose chosen label arrives as the next user message; `ask({ options })` is the same but advisory (no wedge, nothing in the list) |
| `await lander.rest({ clear: true })` | drop the current task's pending wakeup triggers; returns whether any were armed |
| `await lander.artifacts.put(pathOrBytes, { name, mime })` / `.list()` / `.cat(name)` | publish the current task's named output (returns the ref), list its slots, or fetch a slot's current bytes |
| `lander.assist(prompt, …text)` | a one-shot `claude` or `codex` run, returning its trimmed reply |
| `lander.shell(command, …args)` | run `command` under `sh` with args as `$1`, `$2`, …; returns trimmed stdout |
| `await lander.flow(name, inputs)` | run another flow (flows nest) |

`assist` and `shell` run a local child process; everything else calls the same HTTP API the CLI commands do. A non-zero exit from `assist`/`shell` aborts the flow. Since flows are ordinary `.js` under the repo root (which is `"type": "module"`), they're loaded as ESM with no per-file config. For example:

```js
// data/<project>/flows/triage.js — fan a sibling out per review-requested PR
export default async function (lander) {
  const prs = lander.shell(
    'gh pr list --search "review-requested:@me" --json number -q ".[].number"',
  )
  for (const pr of prs.split('\n').filter(Boolean)) {
    await lander.launch(`Review PR #${pr} using \`gh pr diff ${pr}\`.`)
  }
}
```

### Frontend (`src/App.tsx`)

Single component: sidebar (task list + new-task form) and a detail pane (message thread + reply composer). Enter submits, Shift/Option+Enter for newlines; shows an agent-specific "Claude is working…" or "Codex is working…" indicator when the last message is from the user.

Each task row carries a **kebab (⋮) menu** with the status actions — **Wedge** / **Rest** / **Land** / **Launch** — plus **Archive**. Only the items that would be both visible *and* enabled for the row's status appear (e.g. a landed task offers Wedge/Rest/Archive but not Land; a riding task can't be archived), so the menu never shows a dead option. The menu is `position: fixed`, anchored to the kebab's live rect, so the scrolling list can't clip it, and arrow keys move between items. Archived tasks are hidden by default; the project dropdown has a **Show archived** toggle that merges them in (each row dimmed and tagged `archived`), where the kebab offers only **Restore**.

Each streamed turn renders its activity trace as steps. A `tool_use` step is a chip beside its one-line input; the server pairs it with its `tool_result` (by `tool_use_id`) and flags whether that result was an error and, specifically, a **permission refusal** (from the turn's authoritative `permission_denials`, reconciled at turn end). A refused or otherwise failed call's chip is red. When a chip has revealable detail — the full untruncated input, a file-writing tool's diff, another tool's captured output, or a nested subagent trace — a disclosure triangle (and clicking the chip itself) expands it; ⌥/⇧-click toggles every chip in the message at once. A chip with no detail is a plain, non-interactive label.

When a finished turn had any confirmed denials, a muted **"N permissions blocked this turn"** line appears at the foot of the assistant message; clicking it opens a popup that lists each denied call as an editable `settings.json`-style rule (e.g. `Bash(npm run build)`) — click a rule to edit it, then grant the result in **task** or **project** scope from the row's kebab (for Codex, task scope saves the rule for parity and project scope is unsupported). A granted row shows a checkmark and the popup stays open for the turn's other denials; clicking outside or pressing Escape dismisses it.

The task header carries a **rubber-stamp button** (beside the copy-id / read-only controls) — the always-available grant control. It opens the same rule-row UI with a single empty editable row, so a rule can be authored and granted proactively (task or project scope) without hunting through denied chips, over the same `/allow` endpoint.

## Notable details

- `status` moves through `riding` (agent working) → `resting` (idle) when a turn finishes; an agent can also set its own status — `wedged` (needs the user) or the terminal `landed` — via the `lander` CLI (see Self-management).
- **Archiving** is orthogonal to status: it just relocates a task's JSON to `archived/` so it leaves the list and the scheduler/recovery sweeps. Any non-`riding` task can be archived (from the row's kebab menu or `lander archive`); restoring moves it back. An archived task keeps its status and history untouched.
- Reads are unauthenticated (only permission *changes* check a principal — see Authenticated permission grants); delivery is by 2s polling, not SSE/websockets — though the turn itself streams (see Frontend).
- Task IDs are validated as UUIDs before filesystem access, which guards against path traversal on the `:id` route.
