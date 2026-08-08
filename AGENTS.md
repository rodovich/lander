# Working on lander

Lander is a local web app for spawning and managing coding-agent tasks against
target project directories. A **task** is a persistent agent session — backed by
`claude` or `codex` — that rides a turn, comes to rest, and can be replied to,
put to sleep with a wakeup, wedged for the user, or landed. Tasks manage
themselves and each other through the in-task `lander` CLI, which calls back into
the server. Three processes run together under `npm run dev`: the React web
client, the Hono API server that owns all task state, and the host daemon that
owns the agent subprocesses. The README covers the architecture in detail.

**This repository is lander itself.** A task working here is running inside the
stack it is editing: your edits hot-reload the client and server and drain the
daemon while it is serving real work, including your own turn. That makes the
running app both the hazard and the test environment.

## Conventions

Follow these when developing lander. Each doc is short; read the one that covers
what you are about to do.

- **[docs/testing.md](docs/testing.md)** — when changing task execution or
  coordination logic, test end-to-end in the running app when possible. Launch
  real sibling tasks as instruments; subagents and one-off `claude -p` runs do
  not reproduce the real permission world or survive a turn boundary.
- **[docs/commit-authoring.md](docs/commit-authoring.md)** — author commits,
  their sequence, and their messages with care. Never commit a surface before it
  works end to end.
- **[docs/adversarial-review.md](docs/adversarial-review.md)** — put a
  substantial design or implementation plan through independent adversarial
  review, on at least two axes, before executing it.
- **[docs/ui-conventions.md](docs/ui-conventions.md)** — when changing the web
  client, follow the styling and markup conventions.

Three rules from those docs are worth stating here, because getting them wrong
does damage before anyone reviews it:

- Verify with `npm test` and `npm run typecheck` — both green before **each**
  commit, not once at the end of a series.
- Stage explicit paths. Never `git add -A`: the working tree holds untracked
  local files that must stay out of history, and tracked files another task may
  be editing concurrently.
- Commit directly on `main`; don't push unless asked.

Implementation plans and other working notes live in `docs/tmp/`, which git
ignores. Write them there; never commit one.

For reference rather than convention:
[docs/architecture.md](docs/architecture.md) documents the HTTP surface, task
ids, the permission mechanics behind each provider's flags and profiles, and the
restart/reattach machinery. [docs/codex-support.md](docs/codex-support.md)
covers the provider adapter layer.
