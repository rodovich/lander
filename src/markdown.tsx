import { memo, type JSX, type ReactNode } from 'react'
import renderMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { SKIP, visit } from 'unist-util-visit'
import type { Root } from 'mdast'
import type { Element, ElementContent } from 'hast'
import { CopyButton } from './copyButton'
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
) => { href: string; title: string; status: string } | undefined

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
              hProperties: { className: [TASK_MENTION_CLASS, link.status], title: id },
            },
            children: [{ type: 'text', value: link.title }],
          }
        },
      ],
      { ignore: ['link', 'linkReference'] },
    )
  }
}

// GFM autolinks bare email addresses and www. domains along with http(s) URLs.
// Turn those two back into text: an address in a message is far more often
// one to copy (a test user's) than to mail, and lander's history has no bare
// www. domains to link. A link the author wrote, like
// [me@x.com](mailto:me@x.com) or <me@x.com>, starts with "[" or "<" in the
// source and stays a link.
function remarkUnlinkEmailAndWww() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value)
    visit(tree, 'link', (node, index, parent) => {
      if (!parent || index === undefined) return
      const start = node.position?.start.offset
      if (start !== undefined && '[<'.includes(source[start])) return
      const [only] = node.children
      if (only?.type !== 'text') return
      if (node.url.startsWith('mailto:') || only.value.startsWith('www.')) {
        parent.children.splice(index, 1, only)
        return SKIP
      }
    })
  }
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
          [remarkGfm, { singleTilde: false }],
          remarkUnlinkEmailAndWww,
          [remarkTaskMentions, { linkTask }],
        ],
        urlTransform: safeHref,
        components,
      }),
    detail,
  )
})
