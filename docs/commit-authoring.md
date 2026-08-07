# Commit authoring

Craft commit changes, sequences, and messages with care. A well-authored commit history helps with code review, understanding historical changes, bisecting, merging and resolving conflicts, and minimizing work-in-progress.

## Atomicity and monotonic improvement

- Commit logical changes while working, not as a final task at the end.
- When a large change would be easier to review and understand in small pieces, make the changes in a series of commits.
- When a change involves a substantial mechanical transformation (e.g. moving code, reformatting, or converting to typescript) and a logical change to the same code, first do the mechanical transformation in its own commit, then make the logical change on top.
- Each commit should be an improvement over its parent — no regressions, nothing left to clean up, no substantial new tech debt.
- For enhancements or new features, land the tests in the same commit as the functionality they cover.
- Commits that touch app code must not introduce test failures, lint errors, or type errors.

## Refactoring

If a bugfix or enhancement will produce sprawling changes, stop and consider whether a refactor would make the desired change trivial. If so, refactor first, in its own commit(s) that don't break anything and would be safe to deploy on their own, and then make the trivial behavioral change on top.

This is a deliberate divergence from "red, green, refactor" pattern. By refactoring at the start rather than at the end:

- Less tech debt is taken on during development.
- The branch remains safe to review, merge, and deploy at any commit.
- We get smaller, clearer diffs for the behavioral change.

Before refactoring, make sure the refactored logic is sufficiently tested. If more coverage is needed, commit passing tests for the original implementation before changing the implementation, so that the tests can demonstrate that both implementations produce the same behaviors.

## Verifying before you commit

Run `npm test` and `npm run typecheck`, and get both green, before each commit — not once at the end of a series. A commit whose tests were never run is a commit that has to be re-verified by whoever bisects to it.

Unit tests cover the pure logic. Changes to task execution or coordination also get tested end-to-end in the running app before they are committed, following [docs/testing.md](testing.md).

## Staging

Stage explicit paths. Never `git add -A` or `git add .`: the working tree routinely holds untracked local files that must not enter history — `.claude/settings.local.json`, the untracked `docs/*-plan.md` implementation plans, and throwaway probe scripts.

The tree may also hold *tracked* files modified by another task working concurrently in the same checkout. Stage only files you changed yourself; never revert, commit, or delete another task's work in passing. Check `git status` before committing and account for everything you are staging.

Commit directly on `main` — this repo does not branch for ordinary work — and don't push unless asked.

## Don't commit a surface before it works

At no point should `main` hold a commit that is broken or half-implemented in a way the user or a running task could see. No UI element lands before it is functional end to end, and no `bin/lander` subcommand or flag is described in the README or the task prompt before it works.

Plumbing may land ahead of the surface it will eventually serve — server endpoints, protocol fields, daemon wiring, even an undocumented CLI flag — provided nothing yet advertises it. What must not land early is the *announcement*: a README line, a prompt mention, or a control in the UI implies the capability exists.

Lander runs as three processes, so "works end to end" spans all of them: every commit must leave client, server, and daemon mutually compatible. A protocol change cannot land half on one side of the WebSocket, because the running stack reloads them independently — the client and server hot-reload while an already-running daemon keeps serving its in-flight turns. Sequence changes accordingly: additive fields and new readers before the writer flips to them, aliases before renames, and nothing that strands an in-flight run's replay or resume across a daemon relaunch. [docs/testing.md](testing.md) describes that topology and how to verify recovery after each change.

## Commit messages

- Most commits need only a subject line summarizing the change.
- Write the subject as a present-tense imperative sentence ending with a period.
- Subjects ideally should be under 72 characters and never exceed 100.
- If the motivation, context, or impact of a change is non-obvious from the changes and won't fit in a one-liner, then add a body after a blank line. The body should be concise, just one or a few declarative sentences providing the background information.
- Use markdown `code` or list syntax if appropriate.
- Use newlines only between paragraphs or list items. Don't manually break the text for line wrapping. Linus was wrong about this.
