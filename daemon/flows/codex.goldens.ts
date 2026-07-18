// The codex golden corpus, captured against the CURRENT adapter: the reducer now
// preserves real tool names (command_execution / file_change rather than the old
// Bash / FileChange aliases), and args carry scoped permission profiles rather
// than a --sandbox mode.
//
// Note what is absent by design: there is no blocked-call golden. Codex's public
// stream omits sandbox-denied shell items entirely, so no refused call ever
// reaches the reducer and there is no blocked-status folding to reproduce.

import type { Golden } from './testCtx'

const j = (o: unknown) => JSON.stringify(o)

const threadStarted = (id = 'thread-1') =>
  j({ type: 'thread.started', thread_id: id })

const agentMessage = (text: string, id = 'item-msg') =>
  j({ type: 'item.completed', item: { id, type: 'agent_message', text } })

const commandStarted = (id: string, command: string) =>
  j({ type: 'item.started', item: { id, type: 'command_execution', command } })

const commandDone = (
  id: string,
  command: string,
  over: Record<string, unknown> = {},
) =>
  j({
    type: 'item.completed',
    item: {
      id,
      type: 'command_execution',
      command,
      exit_code: 0,
      aggregated_output: 'ok',
      ...over,
    },
  })

const codexStart = { agent: 'codex' as const }

export const CODEX_GOLDENS: Golden[] = [
  {
    name: 'agent message reply',
    chunks: [[threadStarted(), agentMessage('codex says hi')]],
    start: codexStart,
  },
  {
    // A multi-line chunk, so the per-chunk cadence is actually under test here
    // too and not just on the claude side.
    name: 'command execution started and completed in one chunk',
    chunks: [
      [
        threadStarted(),
        commandStarted('item-1', 'ls -la'),
        commandDone('item-1', 'ls -la', { aggregated_output: 'a.ts\nb.ts' }),
      ],
      [agentMessage('listed the files')],
    ],
    start: codexStart,
  },
  {
    name: 'failed command execution',
    chunks: [
      [threadStarted(), commandStarted('item-1', 'false')],
      [
        commandDone('item-1', 'false', {
          exit_code: 1,
          aggregated_output: 'boom',
        }),
      ],
    ],
    start: codexStart,
  },
  {
    // The normal codex shape, not an edge case: a command it never announced
    // starting comes back as item.failed.
    name: 'result-only failed command with no observed start',
    chunks: [
      [threadStarted()],
      [
        j({
          type: 'item.failed',
          item: {
            id: 'item-orphan',
            type: 'command_execution',
            command: 'nope',
            exit_code: 127,
            aggregated_output: 'command not found',
          },
        }),
      ],
    ],
    start: codexStart,
  },
  {
    name: 'file change item',
    chunks: [
      [
        threadStarted(),
        j({
          type: 'item.started',
          item: {
            id: 'item-fc',
            type: 'file_change',
            changes: [{ path: '/repo/a.ts', kind: 'modify' }],
          },
        }),
      ],
      [agentMessage('edited it')],
    ],
    start: codexStart,
  },
  {
    name: 'usage on turn.completed',
    chunks: [
      [threadStarted(), agentMessage('done')],
      [
        j({
          type: 'turn.completed',
          usage: {
            input_tokens: 500,
            cached_input_tokens: 120,
            output_tokens: 42,
          },
        }),
      ],
    ],
    start: codexStart,
  },
  {
    name: 'error event folds into a failed done on a clean exit',
    chunks: [[threadStarted()], [j({ type: 'error', message: 'upstream blew up' })]],
    start: codexStart,
    exitCode: 0,
  },
  {
    name: 'turn.failed folds into a failed done',
    chunks: [
      [threadStarted()],
      [j({ type: 'turn.failed', error: { message: 'model refused' } })],
    ],
    start: codexStart,
    exitCode: 0,
  },
  {
    // The §5.2 guard: a resumed turn re-emits thread.started, and persisting it
    // again would produce a state-patch the adapter never sends.
    name: 'resumed turn re-emitting thread.started writes no duplicate session',
    chunks: [[threadStarted('thread-1'), agentMessage('resumed')]],
    start: {
      ...codexStart,
      sessionId: 'thread-1',
      flowState: { sessionId: 'thread-1' },
    },
  },
  {
    name: 'image turn places -i before the prompt on resume',
    chunks: [[threadStarted('thread-1'), agentMessage('looked')]],
    start: {
      ...codexStart,
      prompt: 'look at this',
      sessionId: 'thread-1',
      flowState: { sessionId: 'thread-1' },
      attachments: [{ id: 'img1', name: 'p.png', mime: 'image/png', size: 9 }],
    },
    input: {
      filesDir: '/tmp',
      materialized: {
        filesDir: '/tmp',
        images: ['/tmp/img1'],
        manifestBlock:
          '<task-attachments>\np.png\n\nThe image(s) above are already attached to your vision.\n</task-attachments>',
      },
    },
  },
  {
    name: 'image turn places -i after the prompt on a fresh exec',
    chunks: [[threadStarted(), agentMessage('looked')]],
    start: {
      ...codexStart,
      prompt: 'look at this',
      attachments: [{ id: 'img1', name: 'p.png', mime: 'image/png', size: 9 }],
    },
    input: {
      filesDir: '/tmp',
      materialized: {
        filesDir: '/tmp',
        images: ['/tmp/img1'],
        manifestBlock:
          '<task-attachments>\np.png\n\nThe image(s) above are already attached to your vision.\n</task-attachments>',
      },
    },
  },
  {
    name: 'edit access synthesizes the scoped workspace profile',
    chunks: [[threadStarted(), agentMessage('ok')]],
    start: { ...codexStart, task: { allowEdits: true } },
  },
  {
    name: 'read-only access synthesizes the read-only profile',
    chunks: [[threadStarted(), agentMessage('ok')]],
    start: { ...codexStart, task: { allowEdits: false } },
  },
  {
    name: 'recorded cwd becomes the launch dir',
    chunks: [[threadStarted(), agentMessage('ok')]],
    start: { ...codexStart, recordedCwd: '/repo/sub' },
    input: { cwd: '/repo/sub' },
  },
  {
    name: 'second ride seeded with a nonzero flowStateRev',
    chunks: [[threadStarted('thread-2'), agentMessage('second ride')]],
    start: {
      ...codexStart,
      runId: 'ride-2',
      flowState: { phase: 'reviewing' },
      flowStateRev: 6,
    },
  },
  {
    // Provider-local item ids restart per thread; the runtime's per-run minting
    // is what keeps two rides' items distinct.
    name: 'later ride reusing the same local item ids',
    chunks: [
      [
        threadStarted('thread-3'),
        commandStarted('item-1', 'echo again'),
        commandDone('item-1', 'echo again'),
      ],
    ],
    start: { ...codexStart, runId: 'ride-9' },
  },
]
