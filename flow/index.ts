// `lander/flow` — the driver stdlib. A flow imports the pure helpers it needs
// from here so it keeps only its own CLI quirks:
//
//   import { reduceStreamLine, buildManifestBlock, gitContext } from 'lander/flow'
//
// The specifier resolves through this package's `exports` self-reference, so tsc,
// tsx (the flow host's runtime), and vitest all reach the same module with no
// alias configuration.
//
// Almost everything here is a *re-export* of an implementation that still lives
// in its original home (server/stream.ts, daemon/attachments.ts, daemon/codex.ts,
// daemon/task-management.ts). That is deliberate: the compiled adapters still
// import from those homes, and re-exporting rather than moving makes flow-vs-
// adapter parity trivially guaranteed — both sides call the identical function
// object. A later step relocates the sources here and re-exports back.
//
// `gitContext` is the one exception: it physically moved (flow/git.ts), because
// it was never claude-specific to begin with. daemon/claude.ts imports it back.

// ── The neutral git snapshot (physically homed here) ────────────────────────
export { gitContext } from './git'

// ── Stream reduction and the item/step vocabulary ───────────────────────────
export {
  reduceStreamLine,
  addUsage,
  summarizeToolInput,
  fullToolInput,
  toolRule,
  diffEdits,
  rawToolResultText,
  summarizeToolResult,
  type Step,
  type Usage,
  type CacheMiss,
} from '../server/stream'

// The codex reducer + session extractor stay sourced in daemon/codex.ts behind
// this façade until a later step relocates them; the codex *flow* imports them
// from here rather than absorbing them.
export { reduceCodexStreamLine, extractCodexSession } from '../daemon/codex'

// ── Attachment manifest ─────────────────────────────────────────────────────
export {
  buildManifestBlock,
  materializeAttachments,
  taskFilesDir,
  defaultFilesRoot,
  isImage,
  type MaterializedFiles,
} from '../daemon/attachments'

// ── Task-management prompt assembly ─────────────────────────────────────────
export {
  fillTaskPrompt,
  forwardableAccess,
  taskManagementPrompt,
  promptWithTaskManagement,
  buildRevivedBlock,
} from '../daemon/task-management'
