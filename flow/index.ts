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
  reduceStreamLine,
  addUsage,
  sessionCost,
  summarizeToolInput,
  fullToolInput,
  toolRule,
  diffEdits,
  rawToolResultText,
  summarizeToolResult,
  type Step,
  type Usage,
  type CacheMiss,
  type SessionTotals,
} from '../server/stream'

// Codex stream reduction and thread identity.
export { reduceCodexStreamLine, extractCodexSession } from './codex-stream'

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
  // Still exported though no bundled flow calls it: it is published stdlib, and
  // a third-party flow whose provider has no deliver-once problem may want it.
  promptWithTaskManagement,
  buildRevivedBlock,
  // Deliver-once, for a provider whose only prose channel is the user message.
  deliveryDigest,
  shouldDeliver,
} from '../daemon/task-management'
