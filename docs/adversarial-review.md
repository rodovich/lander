# Adversarial review

Before a substantial design or implementation plan is executed, it goes through
adversarial review: independent review subagents whose job is to find what is
wrong with it, not to approve it.

## The process

1. **The author writes the plan and does their own pass first.** Fix what you can
   find yourself; reviewers are not a substitute for reading your own work.
2. **Spin up at least two independent review subagents, on at least two different
   axes.** They must not see each other's findings — parallel and blind, not a
   relay. Run them in the foreground and wait for all of them before touching the
   plan; a review that arrives after the work has started is not a review.
3. **Each subagent returns severity-ranked findings**, each grounded in a
   citation to the actual code, and each labeled by type: the plan's premise is
   wrong, the plan is wrong, the plan is internally inconsistent, the plan is
   underspecified, or the plan is missing a failure mode.
4. **Fold in the majors, then issue a fresh round** — new subagents, not the same
   ones iterating, so a reviewer never grades their own correction. Repeat until a
   round produces no major findings.
5. **Record the outcome at the bottom of the plan**: what each round found, what
   was fixed, and what was rejected *and why*. A rejected finding that isn't
   written down gets re-raised by the next round.

For a plan being reviewed against a moving codebase, tell reviewers the commit the
plan was grounded on and have them re-check drift — a plan that was accurate last
week can be stale by the time it is reviewed.

## Axes

Name the axes in the review request. The list is a floor, not a ceiling: ask for
"at least the following questions," so a reviewer who sees a problem you didn't
anticipate reports it rather than treating the list as scope.

The axes that have earned their place, drawn from past reviews:

**Does it solve the problem it aims to solve?** The plainest one, and it still
catches plans that solve an adjacent problem convincingly.

**Is the mechanism proven out** — or does the plan lean on machinery that nothing
has actually exercised? This is where the false-premise failure gets caught. Ask
reviewers to verify every load-bearing present-tense claim about current behavior
against the code, and to report the claim as a finding when it doesn't hold. A
claim about how a harness behaves needs more than a citation: a result from a
bare `claude -p` or `codex exec` run is insufficient to establish how the same
thing behaves inside a lander task.

**Does existing functionality continue to work?** Enumerate what has to keep
working: both providers, permission grants, telemetry, retry asks, drain and
resume, the UI.

**Is it an appropriate solution?** Are aspects of it poor fits for the direction
of the application's development, do they introduce architectural awkwardness, or
are they needlessly complex?

**Is it minimal?** Is every part of the design needed for the stated goal, or
could pieces be removed with no impact? Is there a simpler design that achieves
the same thing?

**Does it generalize, or is it welded to its trigger?** Could the design serve
mechanisms beyond the one that motivated it, or are significant components
substantially limited to that one case?

**Does it hold the layering?** Does it keep the server and web client free of
agent-specific knowledge, and free of knowledge about the specifics of the user's
development environment?

**Does it cover every provider?** Are the resulting capabilities available under
both Claude and Codex, or is some part limited to one? Where the plan accepts a
difference, don't let it pass as given: ask whether an actual difference in what
the harnesses can do forces it, or whether a different design would eliminate it.

**How does it look from the agent's side?** For anything an agent experiences —
delivery timing, token cost, what arrives in the prompt — is the behavior in line
with what the underlying CLIs do natively, or are there noteworthy differences?

**Is there a clear test plan, executable in the running lander instance?** Not
"this should be tested" but named checks someone can run.

**Can the implementation sequence be executed as written without impeding the
running instance?** At no stage may it prevent a relaunched daemon and server from
communicating, block the daemon from draining, or stop task progress from being
recorded.

Two more worth adding when they apply: for a design that replaces a prior rejected
one, **re-ask the questions that killed the predecessor** — carry them forward
explicitly. And for competing sketches, review each independently, fix the majors
on both, then hand the *revised* sketches to fresh subagents, so the comparison is
made between each option's best form.
