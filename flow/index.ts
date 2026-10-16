// Shared helpers available to task drivers through `lander/flow`.

// ── The neutral git snapshot (physically homed here) ────────────────────────
export { gitContext } from './git'

// ── The optional repo-level LANDER.md ───────────────────────────────────────
export {
  readProjectDoc,
  projectDocBlock,
  PROJECT_DOC_FILENAME,
} from './project-doc'

// ── Stream reduction and the item/step vocabulary ───────────────────────────
export {
  addUsage,
  summarizeToolInput,
  fullToolInput,
  toolRule,
  diffEdits,
  rawToolResultText,
  summarizeToolResult,
} from './stream'
export { reduceStreamLine, sessionCost, type SessionTotals } from './claude-stream'
export type { Step, Usage, CacheMiss } from '../shared/stream'

// Codex stream reduction and thread identity.
export {
  reduceCodexStreamLine,
  extractCodexSession,
  codexTurnUsage,
  readThreadUsage,
} from './codex-stream'

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
  checkoutNote,
  buildRevivedBlock,
  buildScheduledRideBlock,
  // Deliver-once, for a provider whose only prose channel is the user message.
  deliveryDigest,
  shouldDeliver,
} from '../daemon/task-management'
