# lander

A web UI for spawning and managing coding agents against target project directories. Each "task" runs a driver flow; the bundled agent drivers are Claude (`claude`), Codex (`codex`), and Antigravity (`agy`). [The flow registry](daemon/flows/index.ts) is the source of truth for bundled flows; [docs/agent-clis.md](docs/agent-clis.md) covers how each CLI is integrated and where they differ.

## What it does

- You create a **task** (title + initial message) in a browser UI and choose an agent.
- For agent tasks, the host daemon runs the selected driver flow, which launches `claude`, `codex`, or `agy` as a CLI subprocess **in the target project directory**, passing your message as the prompt.
- The agent's stream is reduced into activity steps and appended back to the task with the assistant reply.
- You can keep **replying** in a task; follow-up turns resume the same provider session, so context is preserved across the conversation.
- Activity streams into the task as it happens; the UI re-polls 2s after each answer, so steps and the final reply surface within a couple seconds.

## Usage

List the projects lander serves in `~/.lander/config.json` (or the file `LANDER_CONFIG` names):

```json
{
  "projects": [
    { "path": "~/code/app" },
    { "path": "~/code/other" }
  ]
}
```

```sh
npm install
npm run dev
```

`npm run dev /path/to/project [/path/to/another ...]` serves those paths instead, for a one-off run. Either way, each path is resolved and the list is written to `data/served-projects.txt` (newline-separated), which the API server and daemon read; these are the working directories where agent subprocesses run. Then open the web UI on port 41414.

Editing the project list in the config file takes effect without restarting `npm run dev`: the API server restarts, the daemon hands off to a fresh one at turn boundaries, and the web UI picks up the new list within 30 seconds, or at once on reload. A save that won't parse, or lists no projects, is ignored, and lander keeps serving the last good list. A removed project stays served until none of its tasks is mid-turn, so that turn's reply is still recorded. Passing paths on the command line turns this off.

A project entry with `"worktrees": true` gives each of its tasks a git worktree of its own at `<project>/.worktrees/<task id>`. The daemon creates it when a ride starts and finds none — detached at whatever the main checkout has checked out — and launches the agent inside it; it removes it, leaving branches alone, once the task is landed (and its hooks have run) or archived. Lander does nothing project-specific in either step, such as installing dependencies or setting up databases, except for the optional cleanup command below. Add `.worktrees` to the project's `.gitignore`. The flag is re-read whenever the file changes, so turning it on or off applies from each task's next ride.

A project entry can also set `"cleanup": ["bin/drop-worktree-dbs"]`, a program and its arguments, to tear down what a worktree leaves behind. Just before removing a task's worktree, the daemon runs it without a shell, from the project root, with the worktree's path appended. A relative program therefore resolves to the main checkout's copy, not the one the agent could edit. It has 120 seconds. If it fails, the worktree is kept and the error appears on the task's timeline; un-landing and landing the task again, or archiving it, retries.

A project entry can set `"app": { "url": "http://localhost:${PORT}", "envFile": ".env.local" }` to show a link to the app running from a task's checkout. `envFile` is optional and relative to the checkout, and supplies any `${NAME}` in `url`; it is read as text, and nothing is run. The task header shows the link while something is listening on that port, on tasks that haven't landed or been archived.

Add `"start": ["npm", "run", "dev"]` to the `app` block, a program and its arguments, to start the app from the task header. Clicking Start runs that checkout's code, without a shell, and it keeps running after the task's turn ends. Lander stops it after `leaseMinutes` (default 120), when its worktree is removed, or when `npm run dev` stops. The lease starts again whenever you open or return to the task, click the app's link, or send the task a message, and an app isn't stopped while its task is in the middle of a ride. A top-level `maxApps` (default 3) limits how many run at once; starting one more stops the one due to end soonest, skipping any whose task is mid-ride. The task list shows the app icon on the task that started each running app. Its output goes to `~/.lander/app-logs`, and View log in the row's menu shows the end of it.

For Start to work well, a project's app should:

- get a URL that stays the same for a checkout, readable from a file without running anything;
- use a port no other live checkout of the project uses, counting stopped checkouts whose ports are reserved;
- bind exactly that port, failing rather than moving to another when it's taken;
- run in the foreground, need no input, and exit with its children on SIGTERM;
- be safe to start again;
- start shared services, such as a database container, outside its own process group, so Stop leaves them running.

A project with a single checkout only needs the last four.

Each project gets a URL slug from its path (e.g. `/Users/me/code/app` → `users-me-code-app`). The sidebar shows a dropdown to switch projects; choosing one pushes its slug into the URL (`/users-me-code-app/`). Visiting `/` redirects to the first project listed.

## Architecture

**Three processes**, launched together by `dev.mjs` via `concurrently`:

| Part | Stack | Port | Role |
|------|-------|------|------|
| Web | React 18 + Vite | 41414 | SPA, proxies `/api` → 6181 |
| API | Hono on `@hono/node-server` | 6181 | Task CRUD, scheduling, and daemon coordination |
| Daemon | Node host process | — | Owns flow hosts, agent subprocesses (`claude`/`codex`/`agy`), stream reduction, and each flow's usage polling |

- A turn doesn't run as a child of the server. The server sends a flow-neutral `start-run` message to the host daemon over WebSocket. The daemon runs the selected flow in a flow-host subprocess, where agent drivers launch their CLI and reduce its stream into normalized updates. The daemon enforces the idle timeout and keeps a short replay buffer for reconnects. The server applies those updates to task JSON and surfaces a non-zero exit with no reply as an error message.
- Because the daemon survives a server restart, an in-flight turn keeps going across a reload and a fresh server **reattaches** to it, resuming from the persisted run cursor. The server stays the **sole writer of task JSON**; the daemon only owns live process state and replay buffers, so the two can later run on separate hosts.

The HTTP surface, the permission mechanics, and the restart/reattach machinery are documented in [docs/architecture.md](docs/architecture.md).

### Storage

Flat JSON files, one per task, no database. Tasks live under `./data/<normalized-project-path>/tasks/<id>.json`, where the project path is slugified (e.g. `/Users/me/code/app` → `Users-me-code-app`). This namespaces tasks per target project. The task `id` belongs to Lander; the provider session id is stored separately as `flowState.sessionId` after the daemon reports it. The task carries the `runId` and `runCursor` of any run currently in flight so a reloaded server can reattach to the daemon's live replay buffer. Also alongside is `archived/`: archiving a task **moves** its `<id>.json` there, which is how an archived task drops out of the list and out of the scheduler/recovery sweeps (both scan only `tasks/`) — its location on disk is the sole source of truth for the archived state, so nothing is written into the file itself.

### Configuring what tasks may run

Every task can edit, create, and delete files within its project directory and the scratch roots (`/tmp` and `$TMPDIR`). A Claude task can't write `.git`, `.claude`, or paths outside those roots; an Antigravity task runs in `--mode accept-edits` with those roots added; a Codex task can also write the repository's git metadata.

Beyond file edits, each flow enforces its provider's permission model. On Claude and Antigravity, unlisted shell commands and gated tools are denied unless allowed by a rule: granting a rule in **project** scope from the UI writes it to the provider's project config (`.claude/settings.local.json` for Claude, `~/.gemini/config/projects/lander-<hash>.json` for Antigravity), and **task** scope (supported on Claude) keeps it to the one task. Claude also reads rules committed to the target project's `.claude/settings.json` (e.g. `Bash(git:*)`). Codex tasks are governed by a workspace-write sandbox profile rather than allow rules, so the UI omits grant controls on Codex tasks.

[docs/architecture.md](docs/architecture.md) documents how each provider's flags and profiles produce these boundaries.

### Project instructions (`LANDER.md`)

A project may put a `LANDER.md` at its root for conventions that apply to lander tasks specifically. Lander delivers it to assistants in that project, alongside the repo's `CLAUDE.md`/`AGENTS.md`.

### Task hooks

A project may commit JavaScript modules under `.lander/hooks/` that lander runs when its tasks land, wedge, end a ride, or are archived, once you approve them in the **Hooks** panel. [docs/hooks.md](docs/hooks.md) covers writing one; agents in any project can read it with `lander help hooks`.

### Restart & hot reload

Because turns run in the separate host daemon, restarting the API doesn't interrupt in-flight work: the API hot-reloads on server edits, an in-flight turn keeps streaming, and a fresh server reattaches to it without re-running the agent. See [docs/architecture.md](docs/architecture.md) for the graceful-shutdown and reattach mechanics.

### Self-management (`bin/lander`)

A task's agent can call back into lander to manage itself. When the daemon launches a turn, it injects `LANDER_API`, `LANDER_PROJECT`, `LANDER_TASK`, and `LANDER_TOKEN` (a per-task secret) into the agent environment, prepends `bin/` to `PATH`, and delivers task-management instructions to the agent — appended to the system prompt on Claude, and delivered once per session on Codex and Antigravity, which have no request-scoped system-prompt channel. Claude and Antigravity also get `lander` pre-approved (`Bash(lander:*)` and `command(lander)`). So inside any task the agent can run:

| Command | Effect |
|---------|--------|
| `lander land` | Mark **this** task `landed`. |
| `lander wedge [--option id:label]...` | Mark **this** task `wedged` — it's blocked and needs the user. Repeatable `--option id:label` raises a choice ask whose buttons render under your message (your message is the question); the chosen option's label arrives as the next user message. |
| `lander ask --option id:label...` | Raise an **advisory** choice question on **this** task *without* wedging — the task stays paced and nothing appears in the list. The option buttons render under your message and the chosen option's label arrives as the next user message. The user may instead just reply, which supersedes the ask. (Choice-only: a free-text ask would just duplicate the composer.) |
| `lander ride --date <when>` / `--time <minutes>` / `--after <ids>` | Schedule a ride: **this** task rides again when the trigger fires (a time, or other tasks landing); once its turn ends it waits until then, and is notified with a generated message naming the trigger that fired — "Current date: …" for a time, "Tasks landed: …" for `--after`. |
| `lander ride --watch <watcher> [--arg <key>=<value> …]` | Watch: the daemon runs a bundled watcher every five minutes, and **this** task rides again when it fires, woken with the watcher's description of what changed. The watchers are `gh-pr-activity` (`--arg pr=<owner/repo#N or URL>`: the other side of a PR review responds, your review is re-requested, or the PR closes), `gh-review-requests` (`--arg org=<org>` or `repo=<owner/repo>`: a PR requests your review), and `gh-checks` (`--arg pr=<owner/repo#N or URL>`, or `repo` and `sha`: CI checks have all finished, or the first one fails with `fail-fast=true`). Runs that don't fire leave no trace. The watcher must be enabled in the Hooks panel; its first run happens immediately, and if it fires then, nothing is armed. A watcher that fails 12 runs in a row, or fails permanently, wedges the task with the error. |
| `lander ride --clear` | Drop **this** task's scheduled ride (the time or `--after` tasks a prior `ride` set) — for when it is no longer wanted. |
| `lander compose <message>` | Hold a message for `launch` or `send`: prints it back with a check to make before sending it, and the id to pass as `--composed`. |
| `lander launch --composed <message id>` | Spawn a **sibling** task that runs independently, with a composed message as its first message; prints its id. |
| `lander list [--since/--until <when>] [--text <terms>]` | List this project's tasks (id, status, title, created/updated timestamps), newest first; optionally bounded to a createdAt range and/or filtered by title/message text. |
| `lander view <id>` | Show one task's status and recent conversation. |
| `lander send <task id> --composed <message id>` | With a composed message, ask another task in this project to do something, or tell it something that changes what it is doing — now, or deferred with `--date`/`--time`/`--after`. |
| `lander archive <id> [--restore]` | Archive a task (or `--restore` it) — move it out of the list into `archived/`, or back. |
| `lander attachment ls` / `lander attachment cat <id>` | List **this** task's files (id/name/mime/size) — both the ones sent to it and the ones it attached — or stream one's raw bytes to stdout. See [Attachments](#attachments). |
| `lander attachment put <path>… [--name <n>] [--mime <m>]` | Attach files to the turn **this** task is riding, so they render on the reply (name defaults to the basename; `--name` takes a single path) — see [Outputs](#outputs). |
| `lander help [command]` / `lander <command> --help` | Print usage — the full command index, or one command's flags. `lander help hooks` prints [docs/hooks.md](docs/hooks.md). Print-only: `--help`/`-h`/`help` are intercepted before dispatch, so they never launch or send anything. |

**Choice options are suggested replies, not a control surface.** Write each `--option` label as a potential instruction to the agent that the user could have typed and that the agent could execute without asking anything back. These commands are deliberately absent from the task prompt: they're for flow- and skill-directed use, where a script decides the fork points — conversation-driven agents should just converse.

`land`, `wedge`, and `ride` act on the current task via `LANDER_TASK`; `launch`, `list`, `view`, `send`, and `archive` only need `LANDER_API`/`LANDER_PROJECT`. `list`, `view`, `send`, and `archive` are scoped to the caller's own project: `list` accepts `--status <s>` to filter, `--since`/`--until <when>` to bound the range by createdAt, `--text <terms>` to search title and message text (a term equal to a task's exact id also matches), and `--json` for structured metadata. `--status <s>` takes one of `landed`, `riding`, `paced`, `wedged`, and anything else is rejected rather than filtered with. `--status landed` and a `--since`/`--until` window read the archive alongside the active pool, since that is where most finished work ends up, and mark the rows they found there. A query with `--text` or a live status (`riding`, `paced`, `wedged`), or with no filter at all, reads the active pool alone; `--archived` reads the archive alone. In all cases `list` returns metadata only, never task conversations. `view` accepts `--json` for the full task. `send` takes a composed message (see `compose` below), and leads the delivered message with a bare `From <sender id>:` backlink to the sending task. Every command that takes an `<id>` wants the whole id, as `list`, `launch`, and `view` print it.

With no trigger flag, `send` delivers immediately, queued behind any in-flight turn. With `--date`/`--time`/`--after` (same semantics as `launch`/`ride`) it stashes the message on the recipient as a scheduled message that fires when its time arrives or every `--after` task has landed, whichever comes first. `--await` wakes the sending task once, with the recipient's closing message and any files it attached, when the turn that reads the message ends cleanly — the same courtesy `launch --await` arms for a launcher. A task may only message tasks in its own project.

`lander compose` reads a message from the argument, or from stdin if it's `-`, holds it on the server under the composing task, and prints it back followed by a check: go through each thing it asks its recipient to do against what the user requested, and compose it again without any request that isn't covered. `launch` and `send` take only a message composed this way, by `--composed <message id>`, so a task always sees what it is about to send. A composed message is held in the server's memory for a day, and one lost to a server restart is composed again. Agents in testing added work the user never asked for — most often "open a PR" — to messages for other tasks, and removed it when shown the message back with that check.

`lander launch` accepts `--project <slug>`, `--title <title>`, `--date <when>` / `--time <minutes>` / `--after <ids>`, and `--await`. `--title` names the task directly instead of using the auto-titler. Without `--await` a launch hands the work off; with it, the launching task manages the child and is woken once with the child's closing message, the first time the child finishes a turn cleanly. The wake also carries every file the child attached during that turn with `lander attachment put`, delivered to the launcher the way a `--attach` file is. Deferred launches are created paced and the scheduler wakes them when their trigger fires; a paced scheduled task also gets a **Launch** item in its row's kebab menu (see [Frontend](#frontend-src)) to run it early. As a guard against a mistyped flag becoming work, `compose` and `relaunch` refuse a message that is a lone flag-shaped token like `--help` or `--titel`; pass such a string as content via `-` (stdin).

`lander ride` takes the same `--date`/`--time`/`--after` flags (at least one required) to re-sleep a running task: it records a scheduled or awaiting event and, once its turn ends and the scheduler wakes it, notifies it with a generated message naming the trigger that fired: `Current date: <time>` for a time (matching the time `lander ride` printed when it scheduled the ride), `Tasks landed: <ids>` for `--after`. Only a time trigger carries a timestamp — for the others the moment is not the condition that was met. The UI shows the notification folded under a "received a notification" note rather than as the user's message. A task launched by hand from the UI, ahead of any trigger, resumes with the user's own "go ahead" instead; nothing may claim a condition that never fired. A message from the user clears a scheduled time and tells the woken turn so; a message from another task or an `--await` wake leaves the ride scheduled, and every turn that starts with a ride scheduled is reminded of it in a `<ride-scheduled>` block. `lander ride --clear` drops the scheduled ride without touching status or rewriting history. The CLI is a zero-dependency Node script that talks to the local HTTP API, so the server stays the single source of truth; actual agent subprocesses are launched by the daemon, not by the CLI.

#### Attachments

Messages can carry file/image attachments. From the web UI, a **paperclip** below the new-task and reply composers attaches files; from the CLI, `lander launch` and `lander send` take `--attach <paths…>` (variadic — put it last, after the message, since it consumes following args up to the next `--flag`). Attachments are uploaded to a durable per-project blob store (`data/<project>/attachments/`, an `<id>` blob plus an `<id>.json` metadata sidecar) and carried on the message as refs (`{id, name, mime, size}`) — never inlined into the prompt.

At turn time the daemon lazily materializes a task's attachments into a per-task dir on its host (`LANDER_FILES_DIR`, cached across turns), writes a `manifest.json`, and appends a small **manifest block** (ids/names/sizes, never the bytes) to the outgoing prompt. Images are listed with local paths so each agent can open them with its image-viewing tool when needed. The Claude and Antigravity flows grant `--add-dir` for the store dir so their file-reading tools can reach them. To read any attached file's bytes an agent runs `lander attachment cat <id>` (a pure local read of `$LANDER_FILES_DIR/<id>` — no server call, no sandbox widening), and `lander attachment ls` lists the current task's files with sizes, each prefixed with the turn it belongs to (`1/report.md`) so two files sharing a name stay distinguishable.

#### Outputs

A task's **outputs** are the same thing as its inputs, differing only in which message carries them: `lander attachment put <path>… [--name <n>] [--mime <m>]` stores a blob per path and records the ref on the flow item for the turn the task is riding, so the file renders as a chip on that reply. If the turn has emitted nothing yet, the attachment opens its first item and becomes the first thing that turn shows — a flow that writes its outputs before it speaks still has them appear where it wrote them.

An HTML output previews as a live page — a component harness with dummy data, an interactive chart — rather than as source. It runs in an iframe sandboxed to an opaque origin (scripts allowed, no access to the lander page) under a CSP that permits only inline and `data:`/`blob:` resources, so the page must be one self-contained file: bundle scripts, styles, and assets inline (e.g. esbuild or `vite-plugin-singlefile`). The preview's **Open in tab** shows it full-window under the same sandbox.

Only the task itself (or the human) may attach to a task's turn: uploading a blob is a project-wide right, but a ref on task T's assistant turn is a claim about what T produced. There is no separate read route — the ref carries a blob id and the project-scoped download serves it — and `put` also caches the blob into `LANDER_FILES_DIR`, so `lander attachment cat <id>` works immediately without a round-trip. Outputs take a larger 100 MiB cap than the 25 MiB message cap, since build outputs run bigger than what a human drags into a composer.

Attaching the same name twice yields two chips, not one: every blob is immutable, the store has no delete, and two publishes are two outputs. An earlier turn's chip therefore keeps serving exactly the bytes and the size that turn attached. (Outputs were once "artifacts" — a mutable name→blob slot per task, where a republish deleted what it displaced and left the earlier turn's ref dangling. A boot migration folded the surviving records into attachments.)

#### Authenticated mutations

Every mutation to the local API requires authentication. Missing or invalid browser/task credentials receive `401`; authenticated callers must also satisfy each operation's authorization rules. The server identifies two **principals** from request headers:

- **The human** — the browser sends a shared UI secret (`X-Lander-UI-Token`). `dev.mjs` mints it once, persists it under `data/.ui-token` (gitignored, mode 0600), inlines it into the client as `VITE_LANDER_UI_TOKEN`, and passes it to the API as `LANDER_UI_TOKEN`. Each goes to the one process that needs it, never onto the shared environment the three processes inherit, and the daemon drops its own copy once it has read it — otherwise the value reaches every task's shell, where presenting it would resolve as the human (`server/secrets.ts`). This narrows the default blast radius rather than making the secret unobtainable: it is still a file a same-user task can read, still served to the browser by the Vite dev server, and still visible in a process's exec-time environment. The human may grant anything.
- **A task** — the `lander` CLI sends its `LANDER_TOKEN` plus its task id/project (`X-Lander-Token`/`X-Lander-Task`/`X-Lander-Project`); the server matches the token against the task's stored secret. A task may set, replace, or clear only its own ride schedule; launching a scheduled task early is browser-only. A task **cannot** add tool rules to itself or anyone else: `POST /tasks/:id/allow` is human only. Tokens are never returned over HTTP, so one task can't read another's to impersonate it.

Hook callbacks authenticate separately with short-lived credentials scoped to their project and target; those credentials grant no access to other mutations.

This is best-effort for a single-user local tool: a fully adversarial task running as the same user could still read `data/.ui-token` off disk. It blocks the realistic failure mode — an agent escalating itself or a child via the documented API — not a determined local attacker.

This makes orchestration patterns possible — e.g. a task that fans out a review per assigned PR:

```sh
gh pr list --search "review-requested:@me" --json number -q '.[].number' |
  while read pr; do
    id=$(lander compose "Review PR #$pr using \`gh pr diff $pr\`." | head -1 | sed 's/^Composed message \(.*\):$/\1/')
    lander launch --composed "$id"
  done
```

### Flows (`lander flow`)

A **flow** is a reusable script stored as `data/<normalized-project-path>/flows/<name>.js` (a sibling of the project's `tasks/` dir) that exports a default async function. A task runs one with `lander flow <name> [--key value …]`; the `--key value` pairs arrive as the flow's `lander.inputs`.

The server only **resolves** the script's path (`GET /api/:project/flows/:name`, guarded against path traversal); the CLI **imports it in-process** and calls its default export with a `lander` object — keeping the server the source of truth for where flows live without taking on execution. Because the flow runs inside the CLI's own Node process, control flow (conditionals, loops, retries, waiting) is just JavaScript, and the same `lander` object exposes the self-management surface as awaitable methods:

| Method | Backed by |
|--------|-----------|
| `lander.inputs` | the `--key value` flags, as an object |
| `await lander.launch(message, { project, title, date, time, after })` | `POST /tasks`; returns the new task's id |
| `await lander.send(target, message, { date, time, after })` | message another task, by id |
| `await lander.view(target)` | returns the **parsed task object** (`.status`, `.title`, `.messages`, …) — not text to re-parse |
| `await lander.list({ status })` | the project's tasks as an array |
| `lander.land()` / `lander.wedge({ options })` / `lander.ask({ options })` / `await lander.ride({ date, time, after })` | act on the current task — bare `wedge()` just sets status, or pass `{ options: [{ id, label }] }` to raise a choice ask whose chosen label arrives as the next user message; `ask({ options })` is the same but advisory (no wedge, nothing in the list) |
| `await lander.ride({ clear: true })` | drop the current task's scheduled ride; returns whether one was scheduled |
| `await lander.attachments.put(pathOrBytes, { name, mime })` / `.list()` | attach a file to the turn this task is riding (returns the ref), or list the files it has locally |
| `lander.assist(prompt, …text)` | a one-shot run of **this task's own provider**, returning its trimmed reply. Read-only: the one-shot cannot run shell commands or write files, so a model asked a question can't alter the checkout it was asked about |
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

### Frontend (`src/`)

`App.tsx` holds the layout and the shared state; the panes are their own modules — the task list, project menu, new-task form, conversation, and composer. A sidebar (task list + new-task form) sits beside a detail pane (message thread + reply composer). Enter submits, Shift/Option+Enter for newlines; an agent-specific "`<Agent>` is working…" indicator shows while a turn is in flight.

Each task row carries a **kebab (⋮) menu** with the status actions — **Wedge** / **Un-wedge** / **Land** / **Un-land** / **Launch** — plus **Archive**. Un-wedge and Un-land clear that status without waking the task. Only the items that would be both visible *and* enabled for the row's status appear (e.g. a landed task offers Wedge/Un-land/Archive but not Land; a riding task can't be archived), so the menu never shows a dead option. The menu is `position: fixed`, anchored to the kebab's live rect, so the scrolling list can't clip it, and arrow keys move between items. Archived tasks are hidden by default; the project dropdown has a **Show archived** toggle that merges them in (each row dimmed and tagged `archived`), where the kebab offers only **Restore**.

Each streamed turn renders its activity trace as steps. A tool call renders as a chip beside its one-line input; as its outcome arrives, the flow records its output and whether the call failed or was **blocked** by a permission refusal. A blocked or otherwise failed call's chip is red. When a chip has revealable detail — the full untruncated input, a file-writing tool's diff, another tool's captured output, or a nested subagent trace — a disclosure triangle (and clicking the chip itself) expands it; ⌥/⇧-click toggles every chip in the message at once. A chip with no detail is a plain, non-interactive label.

When a finished turn had any confirmed denials, a muted **"N permissions blocked this turn"** line appears at the foot of the assistant message; clicking it opens a popup that lists each denied call as an editable permission rule in the flow's syntax (e.g. `Bash(npm run build)` on Claude, `command(npm run build)` on Antigravity) — click a rule to edit it, then grant the result in any scope the flow supports (**task** or **project**) from the row's kebab. A granted row shows a checkmark and the popup stays open for the turn's other denials; clicking outside or pressing Escape dismisses it.

When a task's flow supports permission grants, the task header carries a **rubber-stamp button** (beside the copy-id control) — the always-available grant control. It opens the same rule-row UI with a single empty editable row, so a rule can be authored and granted proactively without hunting through denied chips, over the same `/allow` endpoint.

## Notable details

- `status` moves through `riding` (agent working) → `paced` (idle) when a turn finishes; an agent can also set its own status — `wedged` (needs the user) or the terminal `landed` — via the `lander` CLI (see Self-management).
- **Archiving** is orthogonal to status: it just relocates a task's JSON to `archived/` so it leaves the list and the scheduler/recovery sweeps. Any non-`riding` task can be archived (from the row's kebab menu or `lander archive`); restoring moves it back. An archived task keeps its status and history untouched.
- Task reads are unauthenticated; mutations and attachment downloads require authentication (see Authenticated mutations); delivery is by 2s polling, not SSE/websockets — though the turn itself streams (see Frontend).
