# Architecture notes

Contributor-facing detail behind the README's architecture overview: the HTTP
surface, the id and permission mechanics, and what happens to in-flight work when
the server reloads. The README covers the same ground at the level a person
running lander needs; this file is the level a person changing it needs.

## HTTP API (`server/index.ts`)

- `GET /api/projects` — list the configured projects (`{ path, slug }`); the first is the default.
- `GET /api/:project/tasks` — list a project's tasks (sorted newest-first). `?archived=1` also merges in archived tasks, each tagged `archived: true`. `?view=summary` serves each task without its conversation — no `items`/`rides`, and `scheduledMessages` reduced to `deliverAt`/`relaunch`/`repeat` — which is ~99% of the bytes off a list response; everything else, including the ride-derived `status`, is unchanged. Opt-in on purpose: with no `view` param the response is exactly what it has always been, so an old client or a third-party caller never has to know the parameter exists. Callers that read only metadata should ask for it (the client's link-resolution poll and `lander list` do); anything that reads message text must not.
- `POST /api/:project/tasks` — create a task, store its chosen agent, and queue the first turn on the daemon.
- `POST /api/:project/tasks/:id/messages` — append a user message; the daemon resumes the task's stored provider session. Both this and `POST .../tasks` accept `attachments: id[]` to associate uploaded files with the message.
- `POST /api/:project/attachments` — upload one or more files (multipart) to the project's durable blob store, returning their refs (`{id, name, mime, size}`). `GET /api/:project/attachments/:id` streams a stored file's bytes. Both require an identified caller (the browser's UI token or a task's `LANDER_TOKEN`).
- `POST /api/:project/tasks/:id/artifacts` — publish a task's named output file (multipart `file` + optional `name`), latest version only; `GET /api/:project/tasks/:id/artifacts` lists the slots and `GET .../artifacts/:name` streams the current blob. Only the task itself (or the human) may publish; any identified caller may read.
- `POST /api/:project/tasks/:id/allow` — grant a permission rule (a denied one from the per-turn blocked summary, or one authored proactively from the header grant control). `{ rule, scope }`: for Claude, `scope: "task"` appends `rule` to the task's `allow` list (fed to `--allowedTools` on future turns) and `scope: "project"` writes it to the project's `.claude/settings.local.json`. Codex task rules are saved for parity but do not affect Codex runs yet, and project grants are not supported for Codex tasks. Human-only.
- `POST /api/:project/tasks/:id/archive` — `{ archived }` (default `true`) moves the task's JSON between `tasks/` and `archived/`. Archiving takes a task out of the list (and out of the scheduler's and recovery's view, which only scan `tasks/`); `{ archived: false }` restores it. A `riding` task can't be archived — it has a live run the reducer must keep reattaching to — so the call `409`s until it comes to rest.

All task routes are scoped by the project slug, which selects the host working
directory the agent runs in and the on-disk data dir.

## Task ids

A task id is a short URL-safe token — ten random bytes drawn over a 64-symbol
alphabet — minted by the server and used as the filename stem, the URL segment,
the `LANDER_TASK` env var, and the `X-Lander-Task` header. Tasks refer to each
other by it. Legacy tasks are still keyed by the uuid they were created with,
backfilled from their filename.

Any id arriving from an untrusted source (URL segment, header, await list) is
validated against `/^[A-Za-z0-9_-]{1,64}$/` before it is used to build a
filesystem path. The closed character class excludes `/` and `.`, so the `:id`
route can't traverse, and it admits both shapes.

## Permission mechanics

Claude turns build `--allowedTools` from `Bash(lander:*)` (always) and the task's
`allow` list (rules granted in **task** scope from the per-turn blocked-permissions
summary). Edit access rides `--permission-mode acceptEdits` instead of the
allowlist, plus `--add-dir` for the scratch roots (`/tmp` and `os.tmpdir()` — the
same path on Linux, but distinct on macOS, where `os.tmpdir()` resolves `$TMPDIR`
to a per-user `/var/folders/<hash>/T`).

Naming `Edit`/`Write` in `--allowedTools` is "explicit permission", which escapes
the working-directory boundary — a granted `Write` can create `/tmp/anything`.
`acceptEdits` instead auto-approves file edits and the filesystem Bash commands
(`mkdir`/`touch`/`rm`/`rmdir`/`mv`/`cp`/`sed`) and `>` redirects only for paths
under the cwd, the scratch roots, or the attachment `--add-dir` root, and never
for protected paths (`.git`, `.claude`, shell rc files). So it both bounds edits
and gives edit-capable tasks the delete access a bare `Edit`/`Write` grant can't
express.

It widens nothing else: git and every other Bash command follow the project's
normal `.claude` settings (`settings.json` / `settings.local.json`) plus per-task
allow rules — anything unlisted is denied in headless mode. Project-scoped Claude
grants land in `.claude/settings.local.json`, which the CLI reads on its own.

Codex turns use named permission profiles: read-only tasks extend Codex's built-in
read-only profile, while editable tasks extend its workspace profile and add write
access to the workspace's `.git` path and resolved Git common directory. The
editable profile otherwise preserves workspace-write behavior, including general
filesystem reads and writes to `/tmp` and `$TMPDIR`. Task allow rules are stored
by Lander but do not affect Codex runs yet, and Codex has no separate git gate
inside an editable task.

## Restart and hot reload

Because turns run in the separate host daemon, restarting the API doesn't
interrupt in-flight work — so the API runs under `tsx watch` and hot-reloads on
server edits, including when an agent edits `server/index.ts` while lander targets
its own repo. Two mechanisms keep a reload clean:

- **Graceful shutdown.** On `SIGTERM`/`SIGINT` the server stops the scheduler and
  lets the HTTP server finish in-flight requests before exiting (a 3s timeout
  forces it if a connection won't close), so a reload never drops a write
  mid-flight.
- **Reattach on boot.** `recoverQueues()` scans each task: one with a tracked
  `runId` is **reattached** by asking the daemon to replay updates after the
  persisted cursor, so no output is lost and the agent is never re-run. Only a run
  no connected daemon still owns after the reconnect grace is treated as
  interrupted and **replayed** — pending flags cleared and the turn re-queued (a
  "Resumed at … after the previous run was interrupted" nudge for one that already
  replied, or the opening message replayed for one that never did). Tasks with
  leftover `queued` messages are drained the same way.

[docs/testing.md](testing.md) covers the same topology from the other side: what
it means for a task editing this repo while the stack is serving its own turn.
