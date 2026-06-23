// The pure stream-json reducer: it folds one line of claude's CLI output into
// the activity Steps it contributes and any final reply text it carries. Kept
// free of I/O so the same reduction serves both a live child process and a run
// read back from its on-disk log — and so it can be unit-tested in isolation.

export type Step = {
  kind: 'text' | 'tool_use' | 'tool_result'
  text?: string
  tool?: string
  input?: string
  // The tool call's id, carried on both the tool_use step and its matching
  // tool_result step so the UI can pair a call with its outcome.
  toolUseId?: string
  // tool_use only: the call rendered as a settings.json permission string
  // (e.g. `Bash(npm run build)`), used to seed the "allow" popup.
  rule?: string
  // tool_use only, for the file-writing tools (Edit/Write/MultiEdit): the change
  // as before/after hunks, so the UI can reveal a diff under the chip. One hunk
  // per edit (MultiEdit has several); Write has a single hunk with empty `old`.
  // Absent for every other tool.
  edits?: { old: string; new: string }[]
  // tool_result only: whether the call errored. `blocked` means the call was
  // refused before it ran (permission gate, Bash safety check, or sandbox file
  // block) — set during a turn's terminal result event from its authoritative
  // permission_denials list, not inferred from the result text. Absent means the
  // call ran; the UI reads that as allowed.
  isError?: boolean
  blocked?: boolean
  createdAt: string
}

// Reduce a tool call's input to a one-line summary for the activity chip. Picks
// the most identifying string field, collapses whitespace, and caps the length.
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const v =
    str('file_path') ||
    str('path') ||
    str('command') ||
    str('pattern') ||
    str('query') ||
    str('url') ||
    str('description') ||
    JSON.stringify(i)
  const flat = v.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 200) + '…' : flat
}

// Render a tool call as a settings.json-style permission rule, e.g.
// `Bash(npm run build)` or `Read(/path/to/file)`. Keys off the same identifying
// field as summarizeToolInput but leaves it untruncated, so the popup can show —
// and let the user grant — the exact invocation. A tool with no obvious
// specifier becomes a bare tool name.
export function toolRule(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name
  const i = input as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const spec =
    str('command') ||
    str('file_path') ||
    str('path') ||
    str('pattern') ||
    str('query') ||
    str('url')
  return spec ? `${name}(${spec})` : name
}

// Pull the before/after hunks out of a file-writing tool's input so the UI can
// show its diff: Edit is one hunk (old_string → new_string), MultiEdit is one
// per entry, and Write is a single hunk against an empty original. Returns
// undefined for any other tool. Each side is capped so a giant edit can't bloat
// the task file; the UI only needs a readable peek.
export function diffEdits(
  name: string,
  input: unknown,
): { old: string; new: string }[] | undefined {
  if (!input || typeof input !== 'object') return undefined
  const i = input as Record<string, unknown>
  const cap = (v: unknown) => {
    const s = typeof v === 'string' ? v : ''
    return s.length > 4000 ? s.slice(0, 4000) + '\n…' : s
  }
  if (name === 'Edit') {
    if (typeof i.old_string === 'string' && typeof i.new_string === 'string')
      return [{ old: cap(i.old_string), new: cap(i.new_string) }]
  } else if (name === 'Write') {
    if (typeof i.content === 'string') return [{ old: '', new: cap(i.content) }]
  } else if (name === 'MultiEdit') {
    if (Array.isArray(i.edits))
      return i.edits
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({
          old: cap((e as Record<string, unknown>).old_string),
          new: cap((e as Record<string, unknown>).new_string),
        }))
  }
  return undefined
}

// Concatenate a tool_result block's content (a plain string or an array of
// content blocks) into its raw text, preserving newlines.
export function rawToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === 'object' ? String((b as any).text ?? '') : ''))
      .join('')
  return ''
}

// A short text peek at a tool_result for the activity trace. Keeps line breaks
// so multi-line output stays readable, but caps the peek at 200 characters or 3
// lines, whichever comes first. A character cap appends an inline ellipsis; a
// line cap puts the ellipsis on its own line.
export function summarizeToolResult(content: unknown): string {
  let text = rawToolResultText(content).trim()
  let charCapped = false
  if (text.length > 200) {
    text = text.slice(0, 200)
    charCapped = true
  }
  const lines = text.split('\n')
  if (lines.length > 3) return lines.slice(0, 3).join('\n') + '\n…'
  return charCapped ? text + '…' : text
}

// Parse one line of claude's stream-json output into the activity steps it
// contributes and any final reply text it carries. Pure — given a line, it
// returns what to append — so the same reduction serves both a live child
// process and a run read back from its on-disk log.
export function reduceStreamLine(
  line: string,
  at: string,
): { steps: Step[]; finalText?: string; blockedIds?: string[] } {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return { steps: [] }
  }
  const steps: Step[] = []
  let finalText: string | undefined
  let blockedIds: string[] | undefined
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text) {
        steps.push({ kind: 'text', text: block.text, createdAt: at })
        finalText = block.text
      } else if (block.type === 'tool_use') {
        steps.push({
          kind: 'tool_use',
          tool: block.name,
          input: summarizeToolInput(block.input),
          toolUseId: block.id,
          rule: toolRule(block.name, block.input),
          edits: diffEdits(block.name, block.input),
          createdAt: at,
        })
      }
    }
  } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_result') {
        steps.push({
          kind: 'tool_result',
          text: summarizeToolResult(block.content),
          toolUseId: block.tool_use_id,
          isError: block.is_error === true,
          createdAt: at,
        })
      }
    }
  } else if (ev.type === 'result') {
    if (typeof ev.result === 'string') finalText = ev.result
    if (Array.isArray(ev.permission_denials))
      blockedIds = ev.permission_denials
        .map((d: any) => d?.tool_use_id)
        .filter((id: unknown): id is string => typeof id === 'string')
  }
  return { steps, finalText, blockedIds }
}
