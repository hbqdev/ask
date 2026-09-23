import http from 'http'
import https from 'https'

import {
  isParseableContentType,
  MAX_PARSEABLE_BYTES
} from './parseable-content'
import { assertUrlAllowed } from './ssrf-guard'

/**
 * Raw HTML GET for the legacy (non-Crawl4AI) crawler in
 * app/api/advanced-search/route.ts.
 *
 * SSRF: every hop goes through the same guard as the `fetch` tool. The
 * starting URL AND each redirect target are checked with `assertUrlAllowed`
 * before a connection is opened, so a public page that 302s to
 * `http://192.168.50.x` or `169.254.169.254` is refused rather than followed.
 * Redirects are capped (a loop or a long chain rejects instead of recursing
 * forever). Residual: DNS rebinding between the check and the connect
 * (TOCTOU), as documented in ssrf-guard.ts.
 */

export const LEGACY_FETCH_MAX_REDIRECTS = 5

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: true
})

export type LegacyFetchOptions = {
  maxRedirects?: number
  /** Injected for tests; defaults to the shared SSRF guard. */
  assertAllowed?: (url: string) => Promise<void>
}

export async function fetchHtml(
  url: string,
  {
    maxRedirects = LEGACY_FETCH_MAX_REDIRECTS,
    assertAllowed = assertUrlAllowed
  }: LegacyFetchOptions = {}
): Promise<string> {
  let current = url
  for (let hop = 0; ; hop++) {
    await assertAllowed(current)
    const res = await getOnce(current)
    if (res.kind === 'body') return res.body
    if (hop >= maxRedirects) {
      throw new Error(`Too many redirects (> ${maxRedirects}) fetching ${url}`)
    }
    current = new URL(res.location, current).toString()
  }
}

type Hop =
  | { kind: 'body'; body: string }
  | { kind: 'redirect'; location: string }

function getOnce(url: string): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:')
    const protocol = isHttps ? https : http
    const agent = isHttps ? httpsAgent : httpAgent
    const request = protocol.get(url, { agent }, res => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        // Drain and hand the target back to the loop, which checks it with
        // the SSRF guard before following.
        res.resume()
        resolve({ kind: 'redirect', location: res.headers.location })
        return
      }
      // Refuse non-pages BEFORE downloading them. Without this a PDF gets
      // pulled in full, concatenated into a JS string, and parsed as HTML by
      // Readability + JSDOM — burning event-loop CPU to produce junk that
      // fails isQualityContent anyway.
      const contentType = res.headers['content-type']
      if (!isParseableContentType(contentType)) {
        res.destroy()
        reject(new Error(`Unsupported content-type: ${contentType}`))
        return
      }

      let data = ''
      let bytes = 0
      res.on('data', chunk => {
        // Size cap too: content-type alone does not bound a pathologically
        // large page, and the parse cost scales with it.
        bytes += chunk.length
        if (bytes > MAX_PARSEABLE_BYTES) {
          res.destroy()
          reject(new Error(`Response exceeded ${MAX_PARSEABLE_BYTES} bytes`))
          return
        }
        data += chunk
      })
      res.on('end', () => resolve({ kind: 'body', body: data }))
    })
    request.on('error', reject)
    request.on('timeout', () => {
      request.destroy()
      resolve({ kind: 'body', body: '' })
    })
    request.setTimeout(10000)
  })
}
