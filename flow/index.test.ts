// Public exports retain the identity of their source helpers.

import { describe, expect, it } from 'vitest'
import * as flow from 'lander/flow'
import * as stream from '../server/stream'
import * as attachments from '../daemon/attachments'
import * as codex from './codex-stream'
import * as taskManagement from '../daemon/task-management'
import { gitContext } from './git'

describe('lander/flow stdlib façade', () => {
  it('re-exports server/stream helpers by identity', () => {
    expect(flow.reduceStreamLine).toBe(stream.reduceStreamLine)
    expect(flow.addUsage).toBe(stream.addUsage)
    expect(flow.summarizeToolInput).toBe(stream.summarizeToolInput)
    expect(flow.fullToolInput).toBe(stream.fullToolInput)
    expect(flow.toolRule).toBe(stream.toolRule)
    expect(flow.diffEdits).toBe(stream.diffEdits)
    expect(flow.rawToolResultText).toBe(stream.rawToolResultText)
    expect(flow.summarizeToolResult).toBe(stream.summarizeToolResult)
  })

  it('re-exports the codex reducer and session extractor by identity', () => {
    expect(flow.reduceCodexStreamLine).toBe(codex.reduceCodexStreamLine)
    expect(flow.extractCodexSession).toBe(codex.extractCodexSession)
  })

  it('re-exports the attachment helpers by identity', () => {
    expect(flow.buildManifestBlock).toBe(attachments.buildManifestBlock)
    expect(flow.materializeAttachments).toBe(attachments.materializeAttachments)
    expect(flow.taskFilesDir).toBe(attachments.taskFilesDir)
    expect(flow.defaultFilesRoot).toBe(attachments.defaultFilesRoot)
    expect(flow.isImage).toBe(attachments.isImage)
  })

  it('re-exports the task-management prompt helpers by identity', () => {
    expect(flow.fillTaskPrompt).toBe(taskManagement.fillTaskPrompt)
    expect(flow.forwardableAccess).toBe(taskManagement.forwardableAccess)
    expect(flow.taskManagementPrompt).toBe(taskManagement.taskManagementPrompt)
    expect(flow.promptWithTaskManagement).toBe(
      taskManagement.promptWithTaskManagement,
    )
  })

  it('serves gitContext from its new stdlib home', () => {
    expect(flow.gitContext).toBe(gitContext)
  })
})
