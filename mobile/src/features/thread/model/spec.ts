// What an answer's ```spec fences carry for the thread to show natively: the
// related follow-up queries and inline images. The fences hold JSONL patches
// (lib/render/prompt.ts) parsed with Ask's parseSpecBlock. Pure: no React.
import type { Spec, UIElement } from '@json-render/core'

import { parseSpecBlock } from '@/lib/render/parse-spec-block'

export type SpecImage = { src: string; title?: string; sourceUrl?: string }

export type SpecContent = { related: string[]; images: SpecImage[] }

const MAX_RELATED = 5

/** Complete fences only: an unterminated trailing fence never matches. */
const SPEC_FENCE_RE = /```spec[^\n]*\n([\s\S]*?)```/g

const HTTP_URL_RE = /^https?:\/\//i

function parsedFences(text: string): Spec[] {
  const specs: Spec[] = []
  for (const match of text.matchAll(SPEC_FENCE_RE)) {
    try {
      specs.push(parseSpecBlock(match[1]))
    } catch {
      // A block that does not parse or validate shows nothing.
    }
  }
  return specs
}

/** The spec's elements in display order: depth-first from the root. */
function elementsInOrder(spec: Spec): UIElement[] {
  const ordered: UIElement[] = []
  const seen = new Set<string>()
  const visit = (key: string) => {
    const element = spec.elements[key]
    if (!element || seen.has(key)) return
    seen.add(key)
    ordered.push(element)
    element.children?.forEach(visit)
  }
  visit(spec.root)
  return ordered
}

function submitQueryOf(element: UIElement): string | undefined {
  if (element.type !== 'Button') return undefined
  const press = element.on?.press
  const bindings = Array.isArray(press) ? press : press ? [press] : []
  for (const binding of bindings) {
    const query = binding.params?.query
    if (
      binding.action === 'submitQuery' &&
      typeof query === 'string' &&
      query.trim()
    ) {
      return query
    }
  }
  return undefined
}

function imageOf(element: UIElement): SpecImage | undefined {
  if (element.type !== 'Image') return undefined
  const { src, title, sourceUrl } = element.props
  if (typeof src !== 'string' || !HTTP_URL_RE.test(src)) return undefined
  const image: SpecImage = { src }
  if (typeof title === 'string') image.title = title
  // Only a web page is opened; any other link falls back to the image.
  if (typeof sourceUrl === 'string' && HTTP_URL_RE.test(sourceUrl)) {
    image.sourceUrl = sourceUrl
  }
  return image
}

/** The related queries (deduped, at most 5) and images of the text's spec fences. */
export function extractSpecContent(text: string): SpecContent {
  const related: string[] = []
  const images: SpecImage[] = []
  for (const spec of parsedFences(text)) {
    for (const element of elementsInOrder(spec)) {
      const query = submitQueryOf(element)
      if (query && !related.includes(query)) related.push(query)
      const image = imageOf(element)
      if (image) images.push(image)
    }
  }
  return { related: related.slice(0, MAX_RELATED), images }
}
