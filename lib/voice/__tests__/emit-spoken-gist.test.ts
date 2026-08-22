import { describe, expect, it, vi } from 'vitest'

import { emitSpokenGist } from '../emit-spoken-gist'

describe('emitSpokenGist', () => {
  it('writes a data-spokenGist part with the answer cleaned for speech', async () => {
    const write = vi.fn()
    await emitSpokenGist(
      { write },
      'The answer is **42** [1](#c1). See https://example.com/x for more.'
    )
    expect(write).toHaveBeenCalledTimes(1)
    const part = write.mock.calls[0][0] as {
      type: string
      data: { text: string }
    }
    expect(part.type).toBe('data-spokenGist')
    // citations, bold markers, and bare URLs are stripped for speech
    expect(part.data.text).not.toMatch(/\[1\]|#c1|https?:\/\/|\*\*/)
    expect(part.data.text).toContain('The answer is 42')
  })

  it('does not write when the cleaned text is empty', async () => {
    const write = vi.fn()
    await emitSpokenGist({ write }, '   ')
    expect(write).not.toHaveBeenCalled()
  })

  it('never throws (fail-open) even if write throws', async () => {
    const write = vi.fn(() => {
      throw new Error('boom')
    })
    await expect(
      emitSpokenGist({ write }, 'hello world')
    ).resolves.toBeUndefined()
  })
})
