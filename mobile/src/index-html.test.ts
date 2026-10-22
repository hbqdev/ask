import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8')

describe('index.html', () => {
  it('fixes the page at its size: no pinch or focus zoom, edge to edge', () => {
    const viewport = [
      ...html.matchAll(/<meta\s+name="viewport"\s+content="([^"]*)"/g)
    ]
    expect(viewport).toHaveLength(1)
    expect(viewport[0][1]).toBe(
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'
    )
  })
})
