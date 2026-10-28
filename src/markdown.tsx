import { memo, type JSX, type ReactNode } from 'react'
import renderMarkdown, { type Components } from 'react-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal'
import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote'
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item'
import { findAndReplace } from 'mdast-util-find-and-replace'
import type { Processor } from 'unified'
import type {} from 'remark-parse'
import type { Root } from 'mdast'
import type { Element, ElementContent } from 'hast'
import { CopyButton } from './copyButton'
import { formatTimestamp } from './format'
import { timed } from './perf'

// Message Markdown: CommonMark plus GFM, rendered by react-markdown to React
// elements (never HTML strings), so raw HTML in a message shows as the literal
// text it was written as.

// Resolves a bare task id found in message text to an internal link to that
// task. Returns the link target and the task's title (used as the link text),
// or undefined when nothing matches — in which case the id renders as literal
// text. Purely presentational: it doesn't touch the stored message or what's
// sent to the model.
export type TaskLinkResolver = (
  id: string,
  projectSlug?: string,
) => { href: string; title: string; status: string; createdAt?: string } | undefined

// Only allow link schemes that can't execute script.
export function safeHref(url: string): string | undefined {
  const trimmed = url.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed
  return undefined
}

// A bare task reference, standing alone rather than embedded in a longer
// identifier. Two id formats have existed, and both appear
// in stored history:
//   - the 36-char uuid legacy tasks are still keyed by, which the server
//     minted (and handed claude as its --session-id) before bee1aab;
//   - the 10-char token drawn from the `[A-Za-z0-9_-]` alphabet minted since,
//     which is what `newTaskId` has always produced.
// The 8..10 bound therefore covers a whole current id plus the two legacy
// *short* forms that old messages abbreviate one to: the first 8 hex chars of
// a uuid, and the 8- or 9-char prefix of a current id that the task prompt
// once told agents to print. The CLI no longer accepts either — this is
// display-only, so those older conversations keep linking. 8 is the floor
// because it is long enough that an ordinary word rarely collides.
const TASK_ID =
  /(?<![0-9A-Za-z_-])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-Za-z_-]{8,10})(?![0-9A-Za-z_-])/gi

const TASK_MENTION_CLASS = 'task-mention'

// Link each bare task id the resolver recognizes, in text outside links and
// code. A candidate the resolver rejects (an ordinary word of the same length)
// stays inside its text node, so a long pasted log doesn't splinter into
// thousands of nodes.
function remarkTaskMentions({ linkTask }: { linkTask?: TaskLinkResolver }) {
  return (tree: Root) => {
    if (!linkTask) return
    findAndReplace(
      tree,
      [
        TASK_ID,
        (id: string) => {
          const link = linkTask(id)
          if (!link) return false
          return {
            type: 'link',
            url: link.href,
            data: {
              hProperties: {
                className: [TASK_MENTION_CLASS, link.status],
                title: link.createdAt ? formatTimestamp(link.createdAt) : undefined,
              },
            },
            children: [{ type: 'text', value: link.title }],
          }
        },
      ],
      { ignore: ['link', 'linkReference'] },
    )
  }
}

// Email addresses in messages usually identify test users; bare www. domains
// have not appeared as useful links in our history. The email tokenizer also
// triggers micromark's quadratic data-token merge on long pasted logs.
// Reinterpreting escapes as links is unnecessary for conversation text.
function remarkMessageGfm(this: Processor) {
  const data = this.data()
  const syntax = gfm({ singleTilde: false })
  // micromark's disable list still breaks text at a disabled construct's
  // registered characters, so disabling the tokenizer alone keeps the merge cost.
  syntax.text = Object.fromEntries(
    Object.entries(syntax.text!).map(([code, value]) => [
      code,
      (Array.isArray(value) ? value : [value!]).filter(
        ({ name }) => name !== 'emailAutolink' && name !== 'wwwAutolink',
      ),
    ]),
  )
  ;(data.micromarkExtensions ??= []).push(syntax)
  const { transforms: _transforms, ...autolink } = gfmAutolinkLiteralFromMarkdown()
  ;(data.fromMarkdownExtensions ??= []).push(
    autolink,
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  )
}

// In CommonMark, a line without `>` after `> quote` is a "lazy continuation"
// of the quoted paragraph, which pulls a reply written on the next line into
// the quote (and fuses alternating `> quote` / `reply` lines into one quote).
// Micromark only keeps an uncontinued container open when the inner paragraph
// continues onto the lazy line; succeeding during `effects.interrupt` ends the
// paragraph instead, so micromark closes the container before the new line.
const noLazyContinuation = {
  flow: {
    null: [
      {
        tokenize(
          this: {
            interrupt?: boolean
            parser: { lazy: Record<number, boolean> }
            now: () => { line: number }
          },
          _effects: unknown,
          ok: (code: number | null) => unknown,
          nok: (code: number | null) => unknown,
        ) {
          return (code: number | null) =>
            this.interrupt && this.parser.lazy[this.now().line] ? ok(code) : nok(code)
        },
      },
    ],
  },
}

function remarkNoLazyContinuation(this: { data: () => object }) {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  ;(data.micromarkExtensions ??= []).push(noLazyContinuation)
}

function textContent(node: ElementContent | Element): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textContent).join('') : ''
}

function ExternalLink({ href, title, children }: { href?: string; title?: string; children: ReactNode }) {
  if (!href) return <>{children}</>
  return (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

const components: Components = {
  a({ href, title, className, children }) {
    // A task mention navigates within the app, like the lifecycle-event task
    // links, so it has no target.
    if (className?.startsWith(TASK_MENTION_CLASS))
      return (
        <a className={className} href={href} title={title}>
          {children}
        </a>
      )
    return <ExternalLink href={href} title={title}>{children}</ExternalLink>
  },
  img({ src, alt, title }) {
    const href = typeof src === 'string' ? src : undefined
    return <ExternalLink href={href} title={title}>{alt || href}</ExternalLink>
  },
  // The copy button matches the one beside a whole message.
  pre({ node }) {
    const text = textContent(node!).replace(/\n$/, '')
    return (
      <pre className="code-block">
        <CopyButton text={text} label="Copy code" className="code-copy" size={14} />
        <code>{text}</code>
      </pre>
    )
  },
}

// Memoized so an unchanged (text, linkTask) pair reuses the prior render instead
// of re-parsing and re-building the element tree. This is what makes a long
// message stop re-rendering on unrelated App updates (poll/scroll/focus); it
// relies on callers passing a referentially stable linkTask (see App's
// resolveTaskLink). Still profiled (opt-in; see perf.ts) so a genuine re-render —
// or a caller that busts the memo — shows up in `landerPerf.report()`.
export const Markdown = memo(function Markdown({
  text,
  linkTask,
}: {
  text: string
  linkTask?: TaskLinkResolver
}): JSX.Element {
  const detail = `${text.length}c${linkTask ? ' +linkTask' : ''}`
  return timed(
    'markdown.render',
    () =>
      renderMarkdown({
        children: text,
        remarkPlugins: [
          remarkMessageGfm,
          remarkNoLazyContinuation,
          [remarkTaskMentions, { linkTask }],
        ],
        urlTransform: safeHref,
        components,
      }),
    detail,
  )
})
