import { spawn } from 'node:child_process'

// Spawn a daemon entry the way daemon-watch.mjs runs it: as a DIRECT node child
// (`node --import tsx`), not via the `tsx` bin. The bin is a wrapper process that
// relays only SIGINT/SIGTERM to the real daemon underneath, so the supervisor's
// drain signal sent to the wrapper pid never reached the daemon — graceful drain
// silently never worked; every superseded daemon sat as a non-draining zombie
// until max-drain's SIGTERM. Direct spawn means kill() hits the daemon itself.
// The IPC channel carries the daemon's report that the server has registered it.
export function spawnDaemonProcess(entry, { cwd, stdio = 'inherit', env = process.env }) {
  return spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd,
    stdio: [stdio, stdio, stdio, 'ipc'],
    env,
  })
}
