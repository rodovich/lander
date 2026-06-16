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

All task routes are scoped by the project slug, which selects the working directory `claude` runs in and the on-disk data dir.
- `runClaude()` shells out with `execFile` (10-min timeout, 50 MB buffer); errors are caught and written back as an assistant message.

### Storage

Flat JSON files, one per task, no database. Tasks live under `./data/<normalized-project-path>/tasks/<uuid>.json`, where the project path is slugified (e.g. `/Users/me/code/app` → `Users-me-code-app`). This namespaces tasks per target project. The task `id` doubles as the Claude `--session-id`.

### Frontend (`src/App.tsx`)

Single component: sidebar (task list + new-task form) and a detail pane (message thread + reply composer). Enter submits, Shift/Option+Enter for newlines; shows a "claude is working…" indicator when the last message is from the user.

## Notable details

- `status` is hardcoded to `"wedged"` on creation and never updated — it's display-only and currently vestigial.
- No auth, no streaming (replies land only when the subprocess fully exits), no websockets — it relies on 2s polling.
- Task IDs are validated as UUIDs before filesystem access, which guards against path traversal on the `:id` route.
