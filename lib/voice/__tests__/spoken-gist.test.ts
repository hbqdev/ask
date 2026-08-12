import { describe, expect, it, vi } from 'vitest'

import { condenseForSpeech } from '../spoken-gist'

describe('condenseForSpeech', () => {
  it('returns the model gist, cleaned for speech', async () => {
    const gen = vi.fn().mockResolvedValue('Nvidia leads [1](#x), followed by AMD.')
    const out = await condenseForSpeech('long answer...', { _generate: gen })
    expect(gen).toHaveBeenCalledOnce()
    expect(out).toBe('Nvidia leads, followed by AMD.')
  })

  it('falls back to the first 2 cleaned sentences when the model throws', async () => {
    const gen = vi.fn().mockRejectedValue(new Error('model down'))
    const answer = 'GPUs are key [1](#a). Prices rose. A third point here.'
    const out = await condenseForSpeech(answer, { _generate: gen })
    expect(out).toBe('GPUs are key. Prices rose.')
  })

  it('falls back on an empty model result', async () => {
    const gen = vi.fn().mockResolvedValue('   ')
    const out = await condenseForSpeech('First. Second. Third.', { _generate: gen })
    expect(out).toBe('First. Second.')
  })
})
