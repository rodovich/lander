// The claude golden corpus, captured against the CURRENT adapter — post-step-2
// arg and reducer changes make any earlier capture stale (acceptEdits + scratch
// root --add-dirs, ride-scoped result folding).
//
// Chunk structure is meaningful, not incidental: each inner array is one stdout
// `data` event. Several goldens deliberately pack multiple lines into one chunk
// so the per-chunk flush cadence is actually under test.

import type { Golden } from './testCtx'

const j = (o: unknown) => JSON.stringify(o)

const init = (model = 'claude-opus-4-8') =>
  j({ type: 'system', subtype: 'init', model })

const assistantText = (
  text: string,
  id = 'msg_1',
  extra: Record<string, unknown> = {},
) => j({ type: 'assistant', message: { id, content: [{ type: 'text', text }] }, ...extra })

const assistantTools = (
  id: string,
  blocks: unknown[],
  extra: Record<string, unknown> = {},
) => j({ type: 'assistant', message: { id, content: blocks }, ...extra })

const toolResult = (
  toolUseId: string,
  content: unknown,
  extra: Record<string, unknown> = {},
) =>
  j({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    ...extra,
  })

const result = (over: Record<string, unknown> = {}) =>
  j({ type: 'result', result: 'all done', ...over })

export const CLAUDE_GOLDENS: Golden[] = [
  {
    name: 'plain text reply',
    chunks: [[init(), assistantText('hello there')], [result({ result: 'hello there' })]],
  },
  {
    // One chunk carrying several lines — the case that makes the cadence assert
    // non-vacuous.
    name: 'single tool call and result in one chunk',
    chunks: [
      [
        init(),
        assistantTools('msg_1', [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
        ]),
        toolResult('toolu_1', 'a.ts\nb.ts'),
      ],
      [assistantText('listed', 'msg_2'), result()],
    ],
  },
  {
    name: 'parallel batch in one inference',
    chunks: [
      [
        init(),
        assistantTools('msg_1', [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/repo/a.ts' } },
          { type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: '/repo/b.ts' } },
        ]),
      ],
      [toolResult('toolu_a', 'aaa'), toolResult('toolu_b', 'bbb')],
      [result()],
    ],
  },
  {
    name: 'subagent trace with sub-subagent nesting',
    chunks: [
      [
        init(),
        assistantTools('msg_1', [
          {
            type: 'tool_use',
            id: 'toolu_agent',
            name: 'Agent',
            input: { subagent_type: 'Explore', description: 'find the reducer' },
          },
        ]),
      ],
      [
        assistantText('looking around', 'msg_sub', {
          parent_tool_use_id: 'toolu_agent',
        }),
        assistantTools(
          'msg_sub',
          [{ type: 'tool_use', id: 'toolu_inner', name: 'Grep', input: { pattern: 'reduce' } }],
          { parent_tool_use_id: 'toolu_agent' },
        ),
        toolResult('toolu_inner', 'server/stream.ts', {
          parent_tool_use_id: 'toolu_agent',
        }),
      ],
      [toolResult('toolu_agent', 'found it'), result()],
    ],
  },
  {
    name: 'edit and write produce diff hunks',
    chunks: [
      [
        init(),
        assistantTools('msg_1', [
          {
            type: 'tool_use',
            id: 'toolu_edit',
            name: 'Edit',
            input: {
              file_path: '/repo/a.ts',
              old_string: 'const a = 1',
              new_string: 'const a = 2',
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_write',
            name: 'Write',
            input: { file_path: '/repo/new.ts', content: 'export const x = 1\n' },
          },
        ]),
      ],
      [toolResult('toolu_edit', 'ok'), toolResult('toolu_write', 'ok'), result()],
    ],
  },
  {
    name: 'blocked call via permission_denials',
    chunks: [
      [
        init(),
        assistantTools('msg_1', [
          { type: 'tool_use', id: 'toolu_deny', name: 'Bash', input: { command: 'rm -rf /' } },
        ]),
      ],
      [toolResult('toolu_deny', 'refused', {}), ],
      [
        result({
          result: 'I was blocked',
          permission_denials: [{ tool_use_id: 'toolu_deny' }],
        }),
      ],
    ],
  },
  {
    name: 'usage across inferences with cache miss and final total',
    chunks: [
      [
        init(),
        assistantTools(
          'msg_1',
          [{ type: 'text', text: 'first' }],
          {},
        ),
      ],
      [
        j({
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [{ type: 'text', text: 'first' }],
            usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5 },
            diagnostics: {
              cache_miss_reason: {
                type: 'system_changed',
                cache_missed_input_tokens: 48815,
              },
            },
          },
        }),
        j({
          type: 'assistant',
          message: {
            id: 'msg_2',
            content: [{ type: 'text', text: 'second' }],
            usage: { input_tokens: 40, output_tokens: 7 },
          },
        }),
      ],
      [
        result({
          usage: {
            input_tokens: 140,
            output_tokens: 17,
            cache_read_input_tokens: 5,
          },
          total_cost_usd: 0.0421,
        }),
      ],
    ],
  },
  {
    name: 'rejecting rate limit event',
    chunks: [
      [init()],
      [
        j({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', resetsAt: 1800000000 },
        }),
      ],
      [result({ result: 'rate limited' })],
    ],
    exitCode: 1,
  },
  {
    // Documents that claude has no in-stream terminal-error channel: an errored
    // result reaches the server as an exit code, not as folded error text the
    // way codex's `error`/`turn.failed` events do.
    name: 'errored result event carries no in-stream terminal error',
    chunks: [
      [init(), assistantText('starting')],
      [j({ type: 'result', subtype: 'error_during_execution', is_error: true })],
    ],
    exitCode: 0,
  },
  {
    name: 'resume of an existing session',
    chunks: [[init(), assistantText('resumed')], [result({ result: 'resumed' })]],
    // Both fields, because that is what runTurn actually sends: the top-level
    // wire field is filled from the accessor's union read, so a task storing its
    // session in flowState still hands the legacy field to the compiled adapter.
    start: {
      sessionId: 'sess-existing',
      flowState: { sessionId: 'sess-existing' },
    },
  },
  {
    // The silent-thread-reset guard: sessionId only at the legacy top level.
    // The flow must --resume it rather than mint, and the harness cannot catch
    // this any other way — each path is otherwise fed its native input shape.
    name: 'legacy top-level session resumes without minting',
    chunks: [[init(), assistantText('legacy resumed')], [result()]],
    start: { sessionId: 'sess-legacy-only' },
  },
  {
    // The rev-seed case: a second ride on a task that already has state. A
    // producer counting from 1 would have this write dropped by the server's
    // `rev <= flowStateRev` guard, and a fresh-task-only suite could not notice.
    name: 'second ride seeded with a nonzero flowStateRev',
    chunks: [[init(), assistantText('second ride')], [result()]],
    start: {
      runId: 'ride-2',
      flowState: { phase: 'reviewing' },
      flowStateRev: 6,
    },
  },
  {
    name: 'unchanged turn context is not re-sent',
    chunks: [[init(), assistantText('same context')], [result()]],
    // Matches what the stub gitContext + no-edit grants produce, so the block
    // compares equal and is neither appended nor re-recorded. Both the top-level
    // fields and flowState are set, mirroring what runTurn sends for a task whose
    // thread identity lives in flowState (the accessors' union read fills both).
    start: {
      sessionId: 'sess-existing',
      turnContext: [
        '<task-context>',
        "Task state as of this message — background context from lander, not the user's words. Re-sent only when it changes.",
        '',
        'You currently have no edit permission, so a spawned task cannot be granted it either.',
        '',
        'GIT-SNAPSHOT-STUB',
        '</task-context>',
      ].join('\n'),
      flowState: {
        sessionId: 'sess-existing',
        turnContext: [
          '<task-context>',
          "Task state as of this message — background context from lander, not the user's words. Re-sent only when it changes.",
          '',
          'You currently have no edit permission, so a spawned task cannot be granted it either.',
          '',
          'GIT-SNAPSHOT-STUB',
          '</task-context>',
        ].join('\n'),
      },
    },
  },
  {
    name: 'task allow rules extend allowedTools',
    chunks: [[init(), assistantText('ok')], [result()]],
    start: {
      task: { allowEdits: false, allow: ['Bash(npm test)', 'Bash(npm run build)'] },
    },
  },
  {
    name: 'edit access adds acceptEdits and scratch roots',
    chunks: [[init(), assistantText('ok')], [result()]],
    start: { task: { allowEdits: true } },
  },
  {
    name: 'no edit access omits acceptEdits and scratch roots',
    chunks: [[init(), assistantText('ok')], [result()]],
    start: { task: { allowEdits: false } },
  },
  {
    // The §3.1 gate split: LANDER_FILES_DIR is set regardless, --add-dir only
    // when the dir exists.
    name: 'nonexistent filesDir still sets the env var but adds no --add-dir',
    chunks: [[init(), assistantText('ok')], [result()]],
    input: { filesDir: '/definitely/not/here/xyz' },
  },
  {
    name: 'worktree task re-enters via argv and snapshots the worktree',
    chunks: [[init(), assistantText('ok')], [result()]],
    start: { task: { allowEdits: false, worktree: 'feature' } },
    input: {
      reentryArgs: ['--worktree', 'feature'],
      effectiveCwd: '/repo/.claude/worktrees/feature',
    },
  },
  {
    name: 'manual cd hint when the recorded cwd differs from the landed dir',
    chunks: [[init(), assistantText('ok')], [result()]],
    start: { recordedCwd: '/repo/sub/dir' },
  },
  {
    name: 'attachment manifest rides the prompt with an --add-dir',
    chunks: [[init(), assistantText('ok')], [result()]],
    start: {
      attachments: [
        { id: 'att1', name: 'shot.png', mime: 'image/png', size: 120 },
        { id: 'att2', name: 'notes.txt', mime: 'text/plain', size: 12 },
      ],
    },
    input: {
      // A real dir, so the existence-gated --add-dir actually fires.
      filesDir: '/tmp',
      materialized: {
        filesDir: '/tmp',
        images: ['/tmp/att1'],
        manifestBlock: '<task-attachments>\nshot.png, notes.txt\n</task-attachments>',
      },
    },
  },
  {
    // The one-shot revival notice: a prompt part like the manifest, deliberately
    // NOT part of the delta-compared context block.
    name: 'revival notice rides the prompt of the reviving turn',
    chunks: [[init(), assistantText('ok')], [result()]],
    start: { revived: { from: 'wedged' } },
  },
  {
    // The other half of the marker: a message that woke a resting task early
    // disarmed its timer, and the notice has to say so or the woken turn silently
    // loses a wakeup it may still want.
    name: 'revival notice names a cleared rest timer',
    chunks: [[init(), assistantText('ok')], [result()]],
    start: { revived: { restUntil: '3:00:00 PM' } },
  },
  {
    name: 'agent stderr is aggregated into the done',
    chunks: [[init(), assistantText('ok')], [result()]],
    stderrChunks: ['warning: something\n'],
    exitCode: 0,
  },
]
