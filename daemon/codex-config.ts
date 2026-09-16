// Codex profile and --config argv helpers, kept free of server dependencies
// so short-lived hook hosts can import them.

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
