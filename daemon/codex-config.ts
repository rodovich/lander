// How a Codex invocation is configured: the profile and `--config` overrides
// lander passes, and the argv they become.
//
// Split out of codex.ts so a caller can build Codex argv without importing the
// adapter, which pulls in `server/stream` for its line reducer. The hook host is
// spawned fresh for every fire and must not import server modules at all, so a
// shared constant reached through the adapter would be a server module arriving
// by a longer route.

export type CodexConfigOptions = {
  // A `~/.codex/config.toml` profile name, when the deployment designates one.
  profile?: string
  // `key=value` lines, each becoming its own `--config` argument.
  configOverrides?: string[]
}

export function codexOptionsFromEnv(env: {
  LANDER_CODEX_PROFILE?: string | undefined
  LANDER_CODEX_CONFIG?: string | undefined
}): CodexConfigOptions {
  const profile = env.LANDER_CODEX_PROFILE?.trim() || undefined
  const configOverrides =
    env.LANDER_CODEX_CONFIG?.split('\n')
      .map((line) => line.trim())
      .filter(Boolean) ?? []
  return {
    ...(profile ? { profile } : {}),
    ...(configOverrides.length ? { configOverrides } : {}),
  }
}

export function codexConfigArgs(
  profile: string | undefined,
  configOverrides: string[],
): string[] {
  return [
    ...(profile ? ['--profile', profile] : []),
    ...configOverrides.flatMap((entry) => ['--config', entry]),
  ]
}
