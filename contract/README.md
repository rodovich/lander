# Contract tests

`npm test` checks lander's side of each agent integration against recorded
streams, so it cannot notice the agent CLI changing under it. These tests run
lander's integrations against the real `claude` and `codex` CLIs to catch that:
a flag renamed, a field that changes meaning, a permission rule that stops
matching.

```sh
npm run test:contract                                  # both CLIs
npm run test:contract -- contract/claude.contract.ts   # one
```

They make live model calls — a full run costs a few cents of Claude usage (on
Haiku) and a handful of low-effort Codex turns — and need each CLI installed and
signed in. A suite whose CLI is missing skips itself; each suite's name carries
the CLI version it ran against. Run them when a CLI updates, or when changing
code that depends on how a CLI behaves.

## Writing one

Prefer driving lander's real flow with `driveLive` (`live.ts`): it runs the
production flow, runtime and server fold with a real child process, so an
assertion on the folded task checks the integration end to end. Use `runJsonl`
on the bare CLI only for a fact no lander code path exercises yet.

Assert one behavior lander depends on, and pair a check that could pass
vacuously with a control that shows it can fail (a sandbox that blocks a write
alongside one that allows it). Models are not deterministic: give exact
instructions, and assert the property under test rather than incidental
behavior around it.

The setup strips `LANDER_*` from the environment and the harness points the
flows at an unreachable API and a stub `lander`, so a probe turn run from inside
a lander task cannot write into that task.
