import { describe, expect, it } from 'vitest'

import { extractReadableContent, MIN_CONTENT_LENGTH } from '../extract-content'

const articleHtml = `
<!doctype html><html><head><title>Test Article — Site Name</title></head>
<body>
  <nav>Home | About | Contact and lots of other navigation chrome</nav>
  <article>
    <h1>The Actual Article Title</h1>
    <p>${'This is a meaningful article sentence with real content. '.repeat(15)}</p>
    <p>${'A second paragraph continues the article with more substance. '.repeat(15)}</p>
  </article>
  <footer>Copyright, privacy links, unrelated footer junk</footer>
</body></html>`

describe('extractReadableContent', () => {
  it('extracts the article body and drops nav/footer chrome', () => {
    const result = extractReadableContent(articleHtml, 'https://example.com/a')
    expect(result).not.toBeNull()
    expect(result!.text.length).toBeGreaterThanOrEqual(MIN_CONTENT_LENGTH)
    expect(result!.text).toContain('meaningful article sentence')
    expect(result!.text).not.toContain('navigation chrome')
    expect(result!.text).not.toContain('footer junk')
  })

  it('returns null for a JS shell with no article content', () => {
    const shell =
      '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script>boot()</script></body></html>'
    expect(extractReadableContent(shell, 'https://example.com/app')).toBeNull()
  })

  it('never throws on malformed input', () => {
    expect(() =>
      extractReadableContent('<<<%%% not html', undefined)
    ).not.toThrow()
  })
})
