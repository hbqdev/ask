import { Readability } from '@mozilla/readability'
import { JSDOM, VirtualConsole } from 'jsdom'

export type ExtractedContent = {
  title: string
  text: string
  byline?: string
  publishedDate?: string
}

// Content shorter than this is treated as extraction failure by callers —
// it usually means a JS shell, a bot-wall interstitial, or an empty page,
// all of which should fall through to the next tier of the fetch chain.
export const MIN_CONTENT_LENGTH = 200

/**
 * Extract the main readable article from raw HTML using Mozilla
 * Readability (the same engine behind Firefox Reader View). Returns null
 * when no article node can be identified — callers keep their existing
 * regex/DOM-walk extraction as the fallback, so a Readability miss never
 * loses content that the old path would have found.
 */
export function extractReadableContent(
  html: string,
  url?: string
): ExtractedContent | null {
  try {
    // Suppress jsdom's noisy CSS/parse warnings — arbitrary web HTML is
    // full of them and they'd flood the container logs.
    const virtualConsole = new VirtualConsole()
    virtualConsole.on('error', () => {})
    virtualConsole.on('warn', () => {})
    virtualConsole.on('jsdomError', () => {})

    const dom = new JSDOM(html, { url, virtualConsole })
    const article = new Readability(dom.window.document, {
      // Readability's default char threshold is 500, which drops short
      // but legitimate pages (release notes, small docs). Halve it and
      // let MIN_CONTENT_LENGTH be the real floor at the call sites.
      charThreshold: 250
    }).parse()

    if (!article?.textContent) return null

    const text = article.textContent.replace(/\s+/g, ' ').trim()
    if (!text) return null

    return {
      title: (article.title || '').trim(),
      text,
      byline: article.byline || undefined,
      publishedDate: article.publishedTime || undefined
    }
  } catch {
    return null
  }
}
