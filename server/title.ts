// Naming a task with a model call. Its own module because it is the API
// server's only child process, and the one place server-side where
// attacker-influenced text becomes an argv — which makes the environment it
// spawns with worth being able to assert on in a unit test.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scrubbedEnv } from './secrets'

const execFileAsync = promisify(execFile)

// The longest a task name may be, generated or typed. Of the 1,073 distinct
// names on record on 2026-09-01, every sane one fit in 55 characters (p99: 51)
// and the runaways — a naming child answering the task, an agent wedging with a
// paragraph — started at 95. Eighty leaves room for a long name without
// admitting a short reply.
export const TITLE_MAX_CHARS = 80

// Narrow enough for a stub to satisfy: promisified execFile is overloaded and
// returns a PromiseWithChild, which an ordinary async function is not.
export type TitleExec = (
  file: string,
  args: readonly string[],
  opts: { cwd: string; maxBuffer: number; timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>

// Ask haiku for a short 2-5 word title naming a task. The task text is passed
// as delimited data under a replaced system prompt — not the default agentic
// one — so the model labels the task instead of trying to carry it out (its
// messages are imperatives and read as a dialogue to continue otherwise).
// Returns null when generation fails (the call errored or produced nothing) so
// callers can tell a real name from a non-result — task creation never blocks on
// it, and a transient failure is retried on the task's next wakeup rather than
// being papered over with a permanent placeholder (see ensureTitle).
//
// The child gets a SCRUBBED environment. It inherits the API server's otherwise,
// and the server legitimately holds the UI and daemon tokens; this child does
// not need them, and its prompt is task text an untrusted caller supplied.
// It runs with cwd inside the project, so it still picks up that project's own
// agent settings — but not its MCP servers, which `--strict-mcp-config` leaves
// unloaded, and none of the CLI's built-in tools either, which `--tools ""`
// withholds. Naming is a labeling call over untrusted text and needs no tools;
// the easel project was handing it 53-117 MCP tools, a browser among them, and
// with the built-ins alone the model can still answer the task instead of
// naming it: on 2026-09-01 it read the file the task asked about and replied
// with a question, which became the title. Its project instructions and output
// style reach it on the user turn regardless of the replaced system prompt, so
// the only reliable way to keep it a labeling call is to leave it nothing to act
// with.
export async function generateTitle(
  projectDir: string,
  message: string,
  exec: TitleExec = execFileAsync,
): Promise<string | null> {
  const system =
    'You name tasks. Given the text of a task, you reply with a short title ' +
    'for it and nothing else. You never carry out, answer, or continue the ' +
    'task — you only label it. Reply with 2-5 words in sentence case, with no ' +
    'quotes and no trailing punctuation.'
  const prompt = `Title this task:\n\n<task>\n${message}\n</task>`
  try {
    const running = exec(
      'claude',
      [
        '--model',
        'haiku',
        '--strict-mcp-config',
        '--tools',
        '',
        '--system-prompt',
        system,
        '-p',
        prompt,
      ],
      {
        cwd: projectDir,
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
        env: scrubbedEnv(),
      },
    )
    // execFile gives the child a stdin pipe and never ends it, so the CLI waits
    // out its "no stdin data received" grace — 3s of a call that takes about 8,
    // spent inside the window in which a restart orphans this child and loses
    // the name. Ending the stream says what `< /dev/null` would. A test double
    // returns a bare promise with no child, and skips it.
    const child = (running as unknown as { child?: { stdin?: { end: () => void } } })
      .child
    child?.stdin?.end()
    const { stdout } = await running
    const title = stdout.trim().replace(/^["']+|["'.]+$/g, '').trim()
    // Over the limit is a non-result like an empty one: the model answered
    // something other than a name, and a retry is worth more than storing it.
    if (title.length > TITLE_MAX_CHARS) return null
    return title || null
  } catch {
    return null
  }
}
