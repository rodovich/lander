// Codex stream transcripts, grouped by stdout chunk.

import type { Golden } from './testCtx'

const j = (o: unknown) => JSON.stringify(o)

const threadStarted = (id = 'thread-1') =>
  j({ type: 'thread.started', thread_id: id })

const turnStarted = () => j({ type: 'turn.started' })

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
    chunks: [[threadStarted(), turnStarted(), agentMessage('codex says hi')]],
    start: codexStart,
  },
  {
    // A multi-line chunk, so the per-chunk cadence is actually under test here
    // too and not just on the claude side.
    name: 'command execution started and completed in one chunk',
    chunks: [
      [
        threadStarted(), turnStarted(),
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
      [threadStarted(), turnStarted(), commandStarted('item-1', 'false')],
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
    name: 'file change item',
    chunks: [
      [
        threadStarted(), turnStarted(),
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
    // A config warning Codex reports before the turn starts, then the turn
    // fails: nothing the model did.
    name: 'notice item before a failed turn',
    chunks: [
      [
        threadStarted(),
        j({
          type: 'item.completed',
          item: { id: 'item_0', type: 'error', message: 'a setting is deprecated' },
        }),
        turnStarted(),
      ],
      [j({ type: 'turn.failed', error: { message: 'model refused' } })],
    ],
    start: codexStart,
    exitCode: 0,
  },
  {
    name: 'usage on turn.completed',
    chunks: [
      [threadStarted(), turnStarted(), agentMessage('done')],
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
    chunks: [[threadStarted(), turnStarted()], [j({ type: 'error', message: 'upstream blew up' })]],
    start: codexStart,
    exitCode: 0,
  },
  {
    name: 'turn.failed folds into a failed done',
    chunks: [
      [threadStarted(), turnStarted()],
      [j({ type: 'turn.failed', error: { message: 'model refused' } })],
    ],
    start: codexStart,
    exitCode: 0,
  },
  {
    // The §5.2 guard: a resumed turn re-emits thread.started, and persisting it
    // again would produce a redundant state-patch.
    name: 'resumed turn re-emitting thread.started writes no duplicate session',
    chunks: [[threadStarted('thread-1'), turnStarted(), agentMessage('resumed')]],
    start: {
      ...codexStart,
      sessionId: 'thread-1',
      flowState: { sessionId: 'thread-1' },
    },
  },
  {
    name: 'resumed image turn supplies a local path in the prompt',
    chunks: [[threadStarted('thread-1'), turnStarted(), agentMessage('looked')]],
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
        manifestBlock:
          '<task-attachments>\np.png\n\nTo view an image, open its local path with your image-viewing tool:\n- p.png: /tmp/img1\n</task-attachments>',
      },
    },
  },
  {
    name: 'fresh image turn supplies a local path in the prompt',
    chunks: [[threadStarted(), turnStarted(), agentMessage('looked')]],
    start: {
      ...codexStart,
      prompt: 'look at this',
      attachments: [{ id: 'img1', name: 'p.png', mime: 'image/png', size: 9 }],
    },
    input: {
      filesDir: '/tmp',
      materialized: {
        filesDir: '/tmp',
        manifestBlock:
          '<task-attachments>\np.png\n\nTo view an image, open its local path with your image-viewing tool:\n- p.png: /tmp/img1\n</task-attachments>',
      },
    },
  },
  {
    name: 'recorded cwd becomes the launch dir',
    chunks: [[threadStarted(), turnStarted(), agentMessage('ok')]],
    start: { ...codexStart, recordedCwd: '/repo/sub' },
    input: { cwd: '/repo/sub' },
  },
  {
    name: 'second ride seeded with a nonzero flowStateRev',
    chunks: [[threadStarted('thread-2'), turnStarted(), agentMessage('second ride')]],
    start: {
      ...codexStart,
      runId: 'ride-2',
      flowState: { phase: 'reviewing' },
      flowStateRev: 6,
    },
  },
  {
    // Codex has no turn-context block, so the revival notice reaching it at all
    // is the point of making it a prompt part.
    name: 'revival notice rides the prompt of the reviving turn',
    chunks: [[threadStarted(), turnStarted(), agentMessage('ok')]],
    start: { ...codexStart, revived: { from: 'landed' } },
  },
  {
    name: 'a turn with a ride still scheduled is reminded of it',
    chunks: [[threadStarted(), turnStarted(), agentMessage('ok')]],
    start: { ...codexStart, scheduledRide: { at: '3:00:00 PM' } },
  },
  {
    // Provider-local item ids restart per thread; the runtime's per-run minting
    // is what keeps two rides' items distinct.
    name: 'later ride reusing the same local item ids',
    chunks: [
      [
        threadStarted('thread-3'),
        turnStarted(),
        commandStarted('item-1', 'echo again'),
        commandDone('item-1', 'echo again'),
      ],
    ],
    start: { ...codexStart, runId: 'ride-9' },
  },
]
