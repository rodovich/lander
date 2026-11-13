# Architecture notes

Contributor-facing detail behind the README's architecture overview: the HTTP
surface, the id and permission mechanics, and what happens to in-flight work when
the server reloads. The README covers the same ground at the level a person
running lander needs; this file is the level a person changing it needs.

## HTTP API (`server/index.ts`)

- `GET /api/projects` — list the configured projects (`{ path, slug }`); the first is the default.
- `GET /api/task-links` — installation-wide `{ id, projectSlug, title, status, archived, createdAt? }` projection used to resolve task references across projects and show their creation time. The first request lazily scans every configured active/archive pool; normal task writes and archive moves then update the index synchronously in memory. Responses carry an ETag, so an unchanged client poll is a bodyless `304` and performs no task-file reads. A failed or ambiguous bootstrap fails closed rather than publishing a partial index.
- `GET /api/:project/tasks` — list a project's tasks (sorted newest-first). `?archived=1` lists archived tasks instead, each tagged `archived: true`. `?view=summary` serves each task without its conversation — no `items`/`rides`, and `scheduledMessages` reduced to `deliverAt`/`relaunch`/`repeat` — which is ~99% of the bytes off a list response; everything else, including the ride-derived `status`, is unchanged. Opt-in on purpose: with no `view` param the response is exactly what it has always been, so an old client or a third-party caller never has to know the parameter exists. Callers that read only metadata should ask for it (`lander list` and the web client's list poll do); the web client fetches the open task whole from `GET /api/:project/tasks/:id`. `?q=<query>` searches the listed tasks' conversations (the prose an opened task shows, not tool calls) and adds `search: { query, matches }` to the response, keyed by task id, each with the match `count` and the first three matches in `list`; `?expand=<id>:<n>,…` lists `n` of a task's matches instead. Every response also carries `flows`, the project's available flows and their capabilities, which the UI uses to populate the new-task picker and to look up a task's `flow`; tasks themselves carry no capability fields, since a daemon's announcement changes them without changing any task. For the same reason, `apps` lists the ids of tasks whose header started an app lander is running, as the daemon last reported; it is not a field on any task.
- `GET /api/:project/tasks/:id` — one task, from either pool. `?conversation=folded|expanded` adds `conversation`: the conversation as plain-text blocks, each agent turn folded as the UI folds it or fully expanded (`shared/conversationText.ts`), which `lander view` prints.
- `POST /api/:project/tasks` — create a task, store its chosen flow, and queue the first turn on the daemon. An explicit `flow` overrides the authenticated launching task’s flow (or a hook target’s flow). Creation without either requires an explicit `flow`; the UI always supplies its selection.
- `POST /api/:project/tasks/:id/messages` — append a user message; the daemon resumes the task's stored provider session. Both this and `POST .../tasks` accept `attachments: id[]` to associate uploaded files with the message.
- `POST /api/:project/tasks/:id/ride` — set, replace, or clear a ride's time/dependency triggers, or arm a watch (`{ watch: { watcher, args } }`). Only the target task itself or the browser may change its schedule; parents and other tasks cannot. A watch is refused unless the daemon announced the watcher and the user switched it on; its first run happens before the endpoint answers.
- `GET /api/watchers` / `POST /api/watchers/:name` — list the bundled watchers with whether each is switched on (`data/watchers.json`), and switch one on or off. Switching is browser-only.
- `POST /api/:project/tasks/:id/launch` — run a scheduled task early, bypassing its time/dependency triggers. Browser-only; the scheduler still launches due tasks internally.
- `POST /api/:project/attachments` — upload one or more files (multipart) to the project's durable blob store, returning their refs (`{id, name, mime, size}`). `GET /api/:project/attachments/:id` streams a stored file's bytes. Both require an identified caller (the browser's UI token or a task's `LANDER_TOKEN`).
- `POST /api/:project/tasks/:id/attachments` — attach a file a task produced to the turn it is riding (multipart `file` + optional `name`), recording the ref on the generating flow item. Only the task itself (or the human) may post: a ref on task T's turn is a claim about what T produced. No read route of its own — the ref carries a blob id, served by the project-scoped download above.
- `POST /api/:project/tasks/:id/allow` — grant a permission rule (a denied one from the per-turn blocked summary, or one authored proactively from the header grant control). `{ rule, scope }`: `scope: "task"` (when the flow's `grants.task` is true, e.g. Claude) appends `rule` to the task's `allow` list, and `scope: "project"` (when `grants.project` is true, e.g. Claude and Antigravity) routes the rule to the flow's `onGrant` handler on the daemon. Unsupported scopes are omitted in the UI and rejected with `400`. Human-only.
- `GET /api/:project/tasks/:id/app` — the app for the task's checkout, asked of the daemon, which owns apps: `{ app: null }` when the project configures none or the task's worktree is gone, else `{ url?, listening, canStart, managed? }`, where `managed` describes an app lander started (phase, time left, whether a ride is holding it, log path). Nothing about apps is stored on the server. The web server's framing policy reads `app.url` from this response (see [The app widget](#the-app-widget)).
- `POST /api/:project/tasks/:id/app/:action` — `start`, `stop` or `restart` the app (answering with its status), or `touch` to renew its lease. `start` and `restart` refuse a landed task. Browser-only, since starting runs the checkout's code. `GET .../app/log` returns the end of the app's output, also browser-only.
- `POST /api/:project/tasks/:id/archive` — `{ archived }` (default `true`) moves the task's JSON between `tasks/` and `archived/`. Archiving takes a task out of the list (and out of the scheduler's and recovery's view, which only scan `tasks/`); `{ archived: false }` restores it. A `riding` task can't be archived — it has a live run the reducer must keep reattaching to — so the call `409`s until it comes to rest.

All task routes are scoped by the project slug, which selects the host working
directory the agent runs in and the on-disk data dir.

## Task ids

A task id is a short URL-safe token — ten random bytes drawn over a 64-symbol
alphabet — minted by the server and used as the filename stem, the URL segment,
the `LANDER_TASK` env var, and the `X-Lander-Task` header. Tasks refer to each
other by it. Legacy tasks are still keyed by the uuid they were created with,
which a since-retired boot migration copied onto the record from the filename
(see [Durable data migrations](#durable-data-migrations)).

Ids are unique only within a project. Server run guards, mutation locks,
provenance, and client selection/draft state therefore key a task by
`(projectSlug, id)`. Bare ids in conversation text still link when they resolve
to exactly one global match; ambiguous ids remain plain text. Persisted records
are also checked against their exact, case-sensitive filename spelling and, when
present, their body `id` before a scoped lookup accepts them.

Any id arriving from an untrusted source (URL segment, header, await list) is
validated against `/^[A-Za-z0-9_-]{1,64}$/` before it is used to build a
filesystem path. The closed character class excludes `/` and `.`, so the `:id`
route can't traverse, and it admits both shapes.

## Code shared by the client and the server

The web client (`src/`) and the server (`server/`) otherwise share no code: the
JSON they exchange is the contract, and the client's types in `src/types.ts`
mirror the server's by hand. `shared/` holds the exception — logic both must run
identically, today the conversation timeline, the turn fold, and the plain-text
rendering of a conversation, so `lander view` folds a turn exactly as the UI
does. Because the same modules load in the browser and under Node, they import
nothing at runtime but each other; they may name the client's item types, which
are erased. `shared/boundary.test.ts` enforces that.

## The app widget

The widget puts one task's conversation inside the app lander started for it.
Five pieces make it up. All but the embed page, which shares the main UI's
components from `src/`, live in `widget/`.

- **The embed page.** `embed.html` (entry `src/embedMain.tsx`, component
  `src/embed.tsx`) shows the task named by its `?project=&task=` query: the
  conversation and the reply box, without the list, the header's controls, the
  usage readout, or permission grants. Its `<base target="_blank">` sends every
  link out of the frame, since every other lander page refuses to be framed.
- **The framing policy.** `widget/viteFramePolicy.ts` sets `frame-ancestors` on every
  response the web server sends outside `/api/`: `'self'`, except on the embed
  page, where it is the origin of the task's app URL from
  `GET .../tasks/:id/app`. Any other answer stays `'self'`, except that a lookup
  that fails (no connection, a 5xx, or a body that isn't JSON, as while the API
  or daemon restarts) falls back on the last origin a lookup confirmed for that
  task, because a refused frame can't retry on its own. The
  web server also sends no CORS headers (`cors: false` in `vite.config.ts`): its
  modules carry the UI token inlined, and Vite's default lets any localhost page
  read them.
- **`LANDER_EMBED_URL`.** The daemon adds the embed page's address to the
  environment of an app it starts (`embedUrl` in `daemon/apps.ts`), with the
  web server's scheme and port from `webOrigin.ts`.
- **The loader.** `widget/main.ts`, with its styles in `widget/widget.css`, is
  served at `/widget.js` as a classic script, so the app needs no CORS from
  lander. The web server bundles it into one IIFE on each request
  (`widget/viteWidgetScript.ts`), so it is current without a watch. It reads the embed page's address from its own
  `data-embed-url`, builds a button and a panel in a shadow root on a
  `<lander-widget>` element at the largest z-index, and frames the embed page
  as soon as it loads, with `allow="clipboard-write"` so copy buttons work.
  Clicking the page outside the widget closes the panel.
- **Presses on the widget's UI.** The app's "click outside" handlers would
  close its popups on a press on the widget's button or the picker's layer. The
  loader keeps those presses, and the releases and clicks that end them, from
  the app (`widget/ownPresses.ts`): a capture-phase listener on the window,
  registered when the script runs and so usually ahead of the app's own, stops
  them and hands them to the widget's handlers itself. A drag that starts in the
  app still ends there, and pressing the widget's button doesn't take focus
  from the app. Presses inside the panel's frame never reach the app, but focus
  moving into the frame still closes a popup that closes on blur.
- **The preview frame.** An attachment preview opened in the panel shows over
  the whole page, in a second frame of the embed page with `?preview` added to
  its query. That page renders only the preview modal. The loader creates the
  frame on the first preview and keeps it, hidden, for the next, and shows it
  only once its page reports ready, so a page that fails to load can't cover
  the app.
- **The element picker.** The composer's pick button, at the right of its
  action row, has the loader hide its button and panel and lay a layer over the
  page that takes the pointer, outlining the element beneath it
  (`widget/picker.ts`). A click describes that element for an agent reading the
  app's source (`widget/describeElement.ts`): the page's URL, a selector that
  matches only it, its role and accessible name, its text, its opening tag, and
  its box. The embed attaches that as `element` where the reply's cursor
  was. Escape cancels.

The loader and the embed pages talk only through `postMessage`, in the messages
`widget/messages.ts` types for both:

| Message | From → to | Meaning |
|---|---|---|
| `lander-embed-ready` | embed → widget | The embed is listening; send it the current state. |
| `lander-widget-view` `{ open, active }` | widget → embed | Whether the panel is open, and whether it's also in view (the page visible and focused). When framed, the embed renders the conversation only while `open`, so each opening scrolls to the first unread entry as opening a task does, and it advances the read marker only while `active`, never on its own focus. |
| `lander-embed-focus` | embed → widget | Focus entered or left the frame; recompute `active`, since focus leaving the frame for another window fires nothing on the page. |
| `lander-task-state` `{ unread, riding }` | embed → widget | What the button shows. |
| `lander-embed-preview` `{ gallery }` | embed → widget | Preview this message's files, starting at `gallery.index`, in the preview frame instead of the panel. |
| `lander-preview-ready` | preview → widget | The preview frame is listening; show it and send it any preview waiting. |
| `lander-widget-preview` `{ gallery }` | widget → preview | Show this gallery's preview. |
| `lander-preview-closed` | preview → widget | The preview closed; hide the frame and return focus to the panel. |
| `lander-embed-pick` | embed → widget | Let the user pick an element on the page. |
| `lander-widget-picked` `{ reference }` | widget → embed | The picked element's description, to attach to the reply. Nothing is sent when picking is cancelled. |

The embed pages send their messages to any origin, since they don't know the page's and
only the task's app may frame them; the widget sends to lander's origin only. The
widget accepts messages only from its frames' windows and lander's origin, and the
embed pages accept messages only from their parent. `vite.config.test.ts`
covers the framing policy's decisions, the CORS setting, and that `/widget.js`
is a classic script under `npm test`;
`browser/widget.test.ts` covers the widget in Chrome (see
[testing](testing.md#browser-tests)).

## Provider layering

Lander hosts more than one agent CLI, and the boundary that keeps that tractable
is that **the server and the web client hold no agent-specific knowledge.** Each
flow — today `claude`, `codex`, and `agy`, plus whatever a daemon announces — declares
capability metadata. The server and client do not branch on a provider's name:
instead, the server derives per-task flags from the flow's declaration and serves
them on the task; the client reads the flags.

Provider-specific mechanics live in the daemon's bundled flows, so the two sections
below describe flow behavior rather than a shape the rest of the system knows
about. When a change needs the server or the client to care about a provider
difference, that difference belongs in the capability declaration.
[docs/agent-clis.md](agent-clis.md) describes each flow's integration.

## Permission mechanics

Each provider reaches its boundary by its own mechanism — Claude through CLI
flags, Codex through a named sandbox profile — and the differences that result
are declared rather than incidental (`grants` in the capability list above).

Claude turns build `--allowedTools` from `Bash(lander:*)` (always) and the task's
`allow` list (rules granted in **task** scope from the per-turn blocked-permissions
summary). Edit access, which every task has, rides `--permission-mode
acceptEdits` instead of the allowlist, plus `--add-dir` for the scratch roots
(`/tmp` and `os.tmpdir()` — the same path on Linux, but distinct on macOS, where
`os.tmpdir()` resolves `$TMPDIR` to a per-user `/var/folders/<hash>/T`).

Naming `Edit`/`Write` in `--allowedTools` is "explicit permission", which escapes
the working-directory boundary — a granted `Write` can create `/tmp/anything`.
`acceptEdits` instead auto-approves file edits and the filesystem Bash commands
(`mkdir`/`touch`/`rm`/`rmdir`/`mv`/`cp`/`sed`) and `>` redirects only for paths
under the cwd, the scratch roots, or the attachment `--add-dir` root, and never
for protected paths (`.git`, `.claude`, shell rc files). So it both bounds edits
and gives tasks the delete access a bare `Edit`/`Write` grant can't express.

It widens nothing else: git and every other Bash command follow the project's
normal `.claude` settings (`settings.json` / `settings.local.json`) plus per-task
allow rules — anything unlisted is denied in headless mode. Project-scoped Claude
grants land in `.claude/settings.local.json`, which the CLI reads on its own.

Codex turns use a named permission profile that extends Codex's workspace profile
and adds write access to the workspace's `.git` path and resolved Git common
directory. It otherwise preserves workspace-write behavior, including general
filesystem reads and writes to `/tmp` and `$TMPDIR`. Task allow rules are stored
by Lander but do not affect Codex runs yet, and Codex has no separate git gate.

## Durable data migrations

Task JSON has no schema version, so a field added to the `Task` record is absent
on every task saved before it. Most such fields are handled by reading through a
fallback at the use site, which needs no migration at all and is the first thing
to reach for. When a field genuinely must exist on disk — because too many call
sites would otherwise have to guard, or because a *rewrite* is needed rather than
a default — lander uses a one-time boot migration, and each part of its shape
earned its place:

- **Run before serving.** The migration is awaited in the boot path ahead of
  `recoverQueues()` and `serve()`, so no request observes a half-migrated store.
- **Go through `mutateTask`.** The server is the sole writer of task JSON, and
  `mutateTask` serializes read-modify-write per file. A migration that writes the
  file directly races live turns streaming into it — hand-editing task JSON while
  the server runs loses the edit.
- **Cover `dataDir` *and* `archiveDir`.** The UI reads archived tasks back, so a
  migration that skips the archive leaves visibly broken records.
- **Be idempotent, and skip early.** Re-read the field's own absence as the guard
  and `continue` when it is already set. The migration then costs one read per
  file on every subsequent boot and writes nothing.
- **Swallow per-file errors.** One unreadable or hand-corrupted file must not stop
  the boot; skip it and carry on.
- **Only walk `PROJECTS`.** A data directory whose project has left
  the served list is never visited, so its tasks stay un-migrated indefinitely.
  That is usually fine — nothing reads them either — but it means "the migration
  has run everywhere" is only ever true of the *configured* projects.

`backfillTasks` in `server/index.ts` is that shape as a helper. Three earlier
migrations — `backfillIds`, `backfillAgents`, `backfillSeen` — were retired once
every configured project read clean; recover one from git history
(`git log -S backfillIds -- server/index.ts`) rather than rewriting the pattern
from this description.

**A migration runs on every hot reload, not just a deliberate restart.** The API
runs under `tsx watch`, so saving the file that adds one restarts the process and
executes it immediately, against real data, in the same edit that wrote it. Take
whatever backup you want *before* the file is saved, not before some later
launch — and treat `mutateTask` as non-negotiable for exactly this reason, since
the reload can land mid-turn on a riding task.

## Run idle timeout

The server supplies a 15-minute idle timeout on every `start-run` message. The
supervisor uses that required value directly and re-arms its watchdog on host
stdout or stderr. There is no separate daemon timeout setting.

The watchdog measures wall-clock silence, and the loop clock counts time the Mac
spent asleep — so a machine that sleeps under a live turn hands the watchdog a run
that looks 15 minutes idle the instant it wakes, and kills it. To narrow that
window the daemon holds a `caffeinate -s -w <pid>` assertion whenever it is riding
anything (`daemon/power.ts`). `-s` is honored only on AC power, which is the policy
we want for a laptop and costs nothing to express; `-w` ties the assertion's life
to the daemon's, so a hard kill can't leave the Mac pinned awake. It only narrows
the window: no assertion survives a closed lid or an explicit Sleep.

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
  "The previous ride was interrupted." notification for one that already
  replied, or the opening message replayed for one that never did). Tasks with
  leftover `queued` messages are drained the same way.

[docs/testing.md](testing.md) covers the same topology from the other side: what
it means for a task editing this repo while the stack is serving its own turn.
