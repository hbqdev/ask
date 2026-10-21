// The answer's markdown, rendered as the web renders it (components/message.tsx):
// Streamdown with KaTeX math, the default rehype plugins (sanitize + harden),
// and text-only completion of a link still streaming in. Two renderers differ
// for the app: a link to a cited source becomes a CitationChip and every other
// link opens in the in-app browser; a markdown image becomes a link.

import { math } from '@streamdown/math'
import {
  createContext,
  useContext,
  type ComponentProps,
  type MouseEvent,
  type ReactNode
} from 'react'
import { defaultRehypePlugins, Streamdown } from 'streamdown'

import { CitationChip } from '@/features/thread/components/CitationChip'
import { openLink } from '@/features/thread/components/open-link'
import { type Source, sourceForHref } from '@/features/thread/model/citations'
import { isCitationLabel } from '@/lib/utils/citation'

// Module-level so the objects are stable: Streamdown memoizes on them.
const PLUGINS = { math }
const REHYPE_PLUGINS = Object.values(defaultRehypePlugins)
// A link still streaming at the tail shows as its text until it completes,
// instead of a "[blocked]" placeholder (see components/message.tsx).
const REMEND = { linkMode: 'text-only' } as const

const HTTP_URL_RE = /^https?:\/\//i

/** The sources the answer's links are matched against. */
const SourcesContext = createContext<Source[]>([])

/** The plain text of a link's label: its text nodes, without any markup. */
function textOf(children: ReactNode): string {
  if (typeof children === 'string') return children
  return Array.isArray(children) ? children.map(textOf).join('') : ''
}

/** A link that opens in the in-app browser, never by navigating the web view. */
function ExternalLink({
  href,
  children
}: {
  href: string
  children: ReactNode
}) {
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    openLink(href)
  }
  return (
    <a href={href} onClick={open} className="answer-link">
      {children}
    </a>
  )
}

/**
 * A rendered link. A citation (a link whose text is a site label, as
 * processCitations writes it) to a known source is a chip; any other http(s)
 * link opens in the in-app browser; a link the renderer blocked, or one with
 * another scheme, is its text.
 */
function AnswerLink({ href, children }: ComponentProps<'a'>) {
  const sources = useContext(SourcesContext)
  if (!href || !HTTP_URL_RE.test(href)) return <>{children}</>
  const source = isCitationLabel(textOf(children))
    ? sourceForHref(href, sources)
    : undefined
  if (source) return <CitationChip source={source} />
  return <ExternalLink href={href}>{children}</ExternalLink>
}

/**
 * A markdown image, shown as a link rather than loaded. An image in the
 * answer is a prompt-injection exfiltration channel: injected content can
 * make the model emit an image whose URL carries conversation data, which an
 * <img> would fetch with no tap at all (components/message.tsx AnswerImage).
 */
function AnswerImage({ src, alt }: ComponentProps<'img'>) {
  const href = typeof src === 'string' && HTTP_URL_RE.test(src) ? src : ''
  const label = alt || href || 'image'
  if (!href) return <>{label}</>
  return <ExternalLink href={href}>{label}</ExternalLink>
}

// Not annotated as streamdown's Components: its index signature would demand
// that every renderer accept Record<string, unknown> props. Streamdown passes
// the element's own props, so the renderers keep their precise types.
const COMPONENTS = { a: AnswerLink, img: AnswerImage }

export type AnswerMarkdownProps = {
  /** The answer as renderableAnswer returns it: citations already resolved. */
  text: string
  /** The message's sources (listSources), which citation links point at. */
  sources: Source[]
  /** Whether the answer is still streaming in. */
  streaming: boolean
}

export function AnswerMarkdown({
  text,
  sources,
  streaming
}: AnswerMarkdownProps) {
  return (
    <SourcesContext.Provider value={sources}>
      <div className="answer-prose">
        <Streamdown
          mode={streaming ? 'streaming' : 'static'}
          plugins={PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          remend={REMEND}
          components={COMPONENTS}
        >
          {text}
        </Streamdown>
      </div>
    </SourcesContext.Provider>
  )
}
