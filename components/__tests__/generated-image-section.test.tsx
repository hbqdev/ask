import React from 'react'

import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { GeneratedImageSection } from '../generated-image-section'

// The glyph is a static hue-cycling SVG (role="img"); stub it so the skeleton's
// activity mark doesn't collide with the real <img> role query below.
vi.mock('../ui/wild-breath-logo', () => ({
  WildBreathGlyph: () => <div data-testid="wb-glyph" />
}))

describe('GeneratedImageSection', () => {
  test('input-available renders a skeleton with the prompt, no image yet', () => {
    render(
      <GeneratedImageSection
        part={{
          type: 'tool-generateImage',
          state: 'input-available',
          input: { prompt: 'a red fox in the snow' }
        }}
      />
    )

    // Prompt is echoed while the render is in flight.
    expect(screen.getByText('a red fox in the snow')).toBeInTheDocument()
    // Activity cue is present…
    expect(screen.getByTestId('wb-glyph')).toBeInTheDocument()
    // …but no image exists yet.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  test('output-available success renders the image and a caption', () => {
    render(
      <GeneratedImageSection
        part={{
          type: 'tool-generateImage',
          state: 'output-available',
          input: { prompt: 'a red fox in the snow' },
          output: {
            imageUrl: '/uploads/user/fox.png',
            modelId: 'black-forest-labs/flux',
            prompt: 'a red fox in the snow'
          }
        }}
      />
    )

    const img = screen.getByRole('img') as HTMLImageElement
    expect(img).toHaveAttribute('src', '/uploads/user/fox.png')
    expect(img).toHaveAttribute('alt', 'a red fox in the snow')
    // Caption shows the prompt only — model identity is hidden, even for
    // legacy parts that still carry a modelId.
    expect(
      screen.getByText('a red fox in the snow', { selector: 'figcaption' })
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/black-forest-labs\/flux/)
    ).not.toBeInTheDocument()
  })

  test('output-available error renders an error card with no image', () => {
    render(
      <GeneratedImageSection
        part={{
          type: 'tool-generateImage',
          state: 'output-available',
          input: { prompt: 'a red fox in the snow' },
          output: { error: 'The Replicate account is out of credit.' }
        }}
      />
    )

    expect(
      screen.getByText(/The Replicate account is out of credit\./)
    ).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  test('output-error suppresses the failed attempt (no lingering skeleton)', () => {
    // The model's first tool call often fails schema validation and retries in
    // the same turn; the failed part must render nothing, not a perpetual
    // "generating" skeleton sitting beside the image the retry produces.
    const { container } = render(
      <GeneratedImageSection
        part={{
          type: 'tool-generateImage',
          state: 'output-error',
          input: { prompt: 'a red fox in the snow' },
          errorText: 'Invalid tool input'
        }}
      />
    )

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('wb-glyph')).not.toBeInTheDocument()
    expect(screen.queryByText('a red fox in the snow')).not.toBeInTheDocument()
  })
})
