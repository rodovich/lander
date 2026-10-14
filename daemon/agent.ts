// The launch directory a flow resolves for its next turn: where the child is
// spawned — the config-load root and (for Claude) the permission boundary.
export type AgentLaunchDir = {
  cwd: string
}

export type AgentLaunchDirInput = {
  root: string
  // The cwd the previous turn's shell ended in (task.cwd), if any.
  recordedCwd?: string
  // Injectable directory probe, so tests don't touch the filesystem.
  isDir(p: string): boolean
}
