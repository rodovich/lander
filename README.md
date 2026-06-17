# lander

A web UI for spawning and chatting with **Claude Code agents** against a target project directory. Each "task" is a persistent `claude -p` session running in your codebase.

## What it does

- You create a **task** (title + initial message) in a browser UI.
- The server launches `claude` as a CLI subprocess **in the target project directory**, passing your message as the prompt.
- Claude's stdout is captured and appended back to the task as an assistant reply.
- You can keep **replying** in a task; follow-up turns resume the same Claude session, so context is preserved across the conversation.
- The UI polls every 2s, so replies appear once the subprocess finishes.

## Usage

```sh
npm install
npm run dev /path/to/project [/path/to/another ...]
```

Each path is resolved and the list is exported as `PROJECT_DIRS` (newline-separated); these are the working directories where `claude` runs. Then open the web UI on port 41414.

Each project gets a URL slug from its path (e.g. `/Users/me/code/app` → `users-me-code-app`). The sidebar shows a dropdown to switch projects; choosing one pushes its slug into the URL (`/users-me-code-app/`). Visiting `/` redirects to the first project passed on the command line.

## Architecture

**Two processes**, launched together by `dev.mjs` via `concurrently`:

| Part | Stack | Port | Role |
|------|-------|------|------|
| Web | React 18 + Vite | 6180 | SPA, proxies `/api` → 6181 |
| API | Hono on `@hono/node-server` | 6181 | Task CRUD + drives the `claude` CLI |

### API (`server/index.ts`)

- `GET /api/projects` — list the configured projects (`{ path, slug }`); the first is the default.
- `GET /api/:project/tasks` — list a project's tasks (sorted newest-first).
- `POST /api/:project/tasks` — create a task; fires off `claude --session-id <uuid> -p <msg>` (fire-and-forget).
- `POST /api/:project/tasks/:id/messages` — append a user message; continues via `claude --resume <uuid> -p <msg>`.
- `POST /api/:project/tasks/:id/allow` — grant a permission rule the agent was blocked on. `{ rule, scope }`: `scope: "task"` appends `rule` to the task's `allow` list (fed to `--allowedTools` on future turns); `scope: "project"` writes it to the project's `.claude/settings.local.json`.

All task routes are scoped by the project slug, which selects the working directory `claude` runs in and the on-disk data dir.
- `runClaude()` shells out with `execFile` (10-min timeout, 50 MB buffer); errors are caught and written back as an assistant message.

### Storage

Flat JSON files, one per task, no database. Tasks live under `./data/<normalized-project-path>/tasks/<uuid>.json`, where the project path is slugified (e.g. `/Users/me/code/app` → `Users-me-code-app`). This namespaces tasks per target project. The task `id` doubles as the Claude `--session-id`.

`runClaude` builds `--allowedTools` per turn from `Bash(lander:*)` (always), `Edit`/`Write`/`MultiEdit` (if `allowEdits`), `Bash(git:*)` (if `allowCommits`), and the task's `allow` list (rules granted via the "allow in task" popup). Project-scoped grants instead land in the project's `.claude/settings.local.json`, which the CLI reads on its own.

### Self-management (`bin/lander`)

A task's agent can call back into lander to manage itself. When `runClaude` spawns `claude`, it injects `LANDER_API`, `LANDER_PROJECT`, and `LANDER_TASK` into the environment, prepends `bin/` to `PATH`, pre-approves `Bash(lander:*)`, and appends a system-prompt note describing the commands. So inside any task the agent can run:

| Command | Effect |
|---------|--------|
| `lander land` | Mark **this** task `landed` (shorthand for `status landed`). |
| `lander status <status>` | Set this task's status to any string. |
| `lander new <message>` | Spawn a **sibling** task that runs independently; prints its id. |

`land` and `status` act on the current task via `LANDER_TASK`; `new` only needs `LANDER_API`/`LANDER_PROJECT`. `lander new` reads the message from the argument, or from stdin if it's `-`, and accepts `--project <slug>`, `--edits`, and `--commits`. The CLI is a zero-dependency Node script that talks to the local HTTP API, so the server stays the single source of truth (e.g. `new` goes through `POST /tasks`, which also fires off the spawned agent and auto-titles it).

This makes orchestration patterns possible — e.g. a task that fans out a review per assigned PR:

```sh
gh pr list --search "review-requested:@me" --json number -q '.[].number' |
  while read pr; do lander new "Review PR #$pr using \`gh pr diff $pr\`."; done
```

So that an agent-set status survives, `runClaude` only resets `riding → wedged` on exit — it won't clobber a terminal status like `landed` the agent set mid-run.

### Frontend (`src/App.tsx`)

Single component: sidebar (task list + new-task form) and a detail pane (message thread + reply composer). Enter submits, Shift/Option+Enter for newlines; shows a "claude is working…" indicator when the last message is from the user.

Each streamed turn renders its activity trace as steps. A `tool_use` step is a clickable chip; the server pairs it with its `tool_result` (by `tool_use_id`) and flags whether that result was an error and, specifically, a **permission refusal** (`is_error` plus a denial-phrase match). A refused call's chip is red. Clicking any chip opens a popup showing the call as an editable `settings.json`-style rule (e.g. `Bash(npm run build)`) and its status (`allowed`/`blocked`/`pending`); for a blocked call it offers **allow in task** and **allow in project**, which POST the (possibly edited) rule to the allow endpoint. Clicking outside or pressing Escape dismisses it.

## Notable details

- `status` moves through `riding` (agent working) → `wedged` (at rest), and an agent can set its own status — including the terminal `landed` — via the `lander` CLI (see Self-management).
- No auth, no streaming (replies land only when the subprocess fully exits), no websockets — it relies on 2s polling.
- Task IDs are validated as UUIDs before filesystem access, which guards against path traversal on the `:id` route.
