// Contract runs spawn real agents whose hooks and shells inherit this process's
// environment. When the suite runs from inside a lander task, that environment
// names the running task and its token, so a hook in a probe turn would write
// into it. Strip every LANDER_* variable before any test spawns anything; the
// harness supplies inert ones per run.
for (const key of Object.keys(process.env))
  if (key.startsWith('LANDER_')) delete process.env[key]

// The Claude flow passes no --model, so a turn uses the account default. Pin the
// cheapest model for probes; set CONTRACT_CLAUDE_MODEL to exercise another.
process.env.ANTHROPIC_MODEL = process.env.CONTRACT_CLAUDE_MODEL ?? 'haiku'
