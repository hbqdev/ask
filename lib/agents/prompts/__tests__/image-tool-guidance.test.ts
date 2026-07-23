import { describe, expect, it } from 'vitest'

import { IMAGE_TOOL_GUIDANCE } from '../image-tool-guidance'

// Guard against the guidance block being accidentally emptied or stripped of
// the two tool contract details the researcher relies on: the tool's name
// (generateImage) and the parameter used to edit/iterate on an existing image
// (baseImageUrl). If either disappears, the model loses the cue for when and
// how to call the tool.
describe('image tool guidance', () => {
  it('exports a non-empty string', () => {
    expect(typeof IMAGE_TOOL_GUIDANCE).toBe('string')
    expect(IMAGE_TOOL_GUIDANCE.trim().length).toBeGreaterThan(0)
  })

  it('mentions the generateImage tool and the baseImageUrl parameter', () => {
    expect(IMAGE_TOOL_GUIDANCE).toContain('generateImage')
    expect(IMAGE_TOOL_GUIDANCE).toContain('baseImageUrl')
  })
})
