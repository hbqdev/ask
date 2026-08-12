import { describe, expect, it, vi } from 'vitest'

vi.mock('../spoken-gist', () => ({
  condenseForSpeech: vi.fn()
}))
import { emitSpokenGist } from '../emit-spoken-gist'
import { condenseForSpeech } from '../spoken-gist'

describe('emitSpokenGist', () => {
  it('writes a data-spokenGist part with the condensed text', async () => {
    vi.mocked(condenseForSpeech).mockResolvedValue('Short spoken summary.')
    const write = vi.fn()
    await emitSpokenGist({ write }, 'the full answer')
    expect(write).toHaveBeenCalledWith({
      type: 'data-spokenGist',
      data: { text: 'Short spoken summary.' }
    })
  })

  it('never throws and writes nothing when condensing fails', async () => {
    vi.mocked(condenseForSpeech).mockRejectedValue(new Error('boom'))
    const write = vi.fn()
    await expect(emitSpokenGist({ write }, 'x')).resolves.toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it('writes nothing for empty gist text', async () => {
    vi.mocked(condenseForSpeech).mockResolvedValue('')
    const write = vi.fn()
    await emitSpokenGist({ write }, 'x')
    expect(write).not.toHaveBeenCalled()
  })
})
