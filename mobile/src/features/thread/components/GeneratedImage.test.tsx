import { Browser } from '@capacitor/browser'
import type { UIMessage } from 'ai'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GeneratedImage } from '@/features/thread/components/GeneratedImage'

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

type Part = UIMessage['parts'][number]

const BASE = 'https://ask.test.invalid'

const imagePart = (state: string, output?: unknown) =>
  ({
    type: 'tool-generateImage',
    toolCallId: 'g1',
    state,
    input: { prompt: 'a red fox at dawn' },
    output
  }) as Part

beforeEach(() => {
  vi.mocked(Browser.open).mockClear()
})

describe('GeneratedImage', () => {
  it('shows a skeleton with the prompt until the image is ready', () => {
    const { container } = render(
      <GeneratedImage part={imagePart('input-available')} baseUrl={BASE} />
    )
    expect(screen.getByRole('status')).toHaveAccessibleName('Generating image')
    expect(screen.getByText('a red fox at dawn')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  it('shows a skeleton with no prompt while the input still streams', () => {
    const part = { ...imagePart('input-streaming'), input: undefined } as Part
    render(<GeneratedImage part={part} baseUrl={BASE} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('prefixes a relative image URL with the API base', () => {
    render(
      <GeneratedImage
        part={imagePart('output-available', {
          imageUrl: '/uploads/fox.png?sig=1',
          prompt: 'a red fox at dawn'
        })}
        baseUrl={BASE}
      />
    )
    const img = screen.getByRole('img', { name: 'a red fox at dawn' })
    expect(img).toHaveAttribute('src', `${BASE}/uploads/fox.png?sig=1`)
  })

  it('keeps an absolute image URL as it is', () => {
    render(
      <GeneratedImage
        part={imagePart('output-available', {
          imageUrl: 'https://cdn.test.invalid/fox.png',
          prompt: 'fox'
        })}
        baseUrl={BASE}
      />
    )
    expect(screen.getByRole('img', { name: 'fox' })).toHaveAttribute(
      'src',
      'https://cdn.test.invalid/fox.png'
    )
  })

  it('opens the full image in the in-app browser on tap', () => {
    render(
      <GeneratedImage
        part={imagePart('output-available', {
          imageUrl: '/uploads/fox.png',
          prompt: 'fox'
        })}
        baseUrl={BASE}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /fox/ }))
    expect(Browser.open).toHaveBeenCalledWith({
      url: `${BASE}/uploads/fox.png`
    })
  })

  it('renders a reloaded dynamic-tool image the same way', () => {
    const part = {
      type: 'dynamic-tool',
      toolName: 'generateImage',
      toolCallId: 'g1',
      state: 'output-available',
      input: { prompt: 'fox' },
      output: { imageUrl: '/uploads/fox.png', prompt: 'fox' }
    } as Part
    render(<GeneratedImage part={part} baseUrl={BASE} />)
    expect(screen.getByRole('img', { name: 'fox' })).toHaveAttribute(
      'src',
      `${BASE}/uploads/fox.png`
    )
  })

  it('shows the error text when generation failed', () => {
    render(
      <GeneratedImage
        part={imagePart('output-available', { error: 'quota exceeded' })}
        baseUrl={BASE}
      />
    )
    expect(
      screen.getByText('Image generation failed: quota exceeded')
    ).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('renders nothing for a call that errored', () => {
    const { container } = render(
      <GeneratedImage part={imagePart('output-error')} baseUrl={BASE} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
