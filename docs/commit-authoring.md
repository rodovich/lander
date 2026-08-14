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

Stage explicit paths. Never `git add -A` or `git add .`. The tree may hold untracked or tracked files modified by another task working concurrently in the same checkout. Stage only files you changed yourself; never revert, commit, or delete another task's work in passing. Check `git status` before committing and account for everything you are staging.

Commit directly on `main` — this repo does not branch for ordinary work — and don't push unless asked.

## Don't commit a surface before it works

At no point should `main` hold a commit that is broken or half-implemented in a way the user or a running task could see. No UI element lands before it is functional end to end, and no `bin/lander` subcommand or flag is described in the README or the task prompt before it works.

Plumbing may land ahead of the surface it will eventually serve — server endpoints, protocol fields, daemon wiring, even an undocumented CLI flag — provided nothing yet advertises it. What must not land early is the *announcement*: a README line, a prompt mention, or a control in the UI implies the capability exists. Sequencing is a property of the commits, not something the message has to assert; the diff shows what is wired and what is not.

Lander runs as three processes, so "works end to end" spans all of them: every commit must leave client, server, and daemon mutually compatible. A protocol change cannot land half on one side of the WebSocket, because the running stack reloads them independently — the client and server hot-reload while an already-running daemon keeps serving its in-flight turns. Sequence changes accordingly: additive fields and new readers before the writer flips to them, aliases before renames, and nothing that strands an in-flight run's replay or resume across a daemon relaunch. [docs/testing.md](testing.md) describes that topology and how to verify recovery after each change.

## Commit messages

- Write the subject as a present-tense imperative sentence ending with a period, ideally under 72 characters and never over 100.
- Most commits need only that subject.
- Write a body only when there's important information that the diff itself will not convey: external motivation for the change, measurements, rationale for removing code. One or two sentences.
- Do not explain the implementation, and don't repeat explanations from comments, docs, help text, etc. The contents of the commit will be in front of the next reader, and a body that repeats it is waste.
- Don't write a body to say a change is unused, incomplete, or a first step; the diff shows that. If the sequencing needs explaining, the body carries the reason for the split, not the fact of it.
- Use markdown `code` where it helps. Use newlines only between paragraphs. Don't manually break the text for line wrapping. Linus was wrong about this.
