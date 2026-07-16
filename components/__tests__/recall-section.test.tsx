import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RecallSection } from '../recall-section'

describe('RecallSection', () => {
  it('renders one linked chip per recalled chat', () => {
    render(
      <RecallSection
        data={{
          chats: [
            { chatId: 'c1', title: 'Backups' },
            { chatId: 'c2', title: 'Monitoring' }
          ]
        }}
      />
    )
    const backups = screen.getByRole('link', { name: /Backups/ })
    expect(backups).toHaveAttribute('href', '/search/c1')
    expect(screen.getByRole('link', { name: /Monitoring/ })).toHaveAttribute(
      'href',
      '/search/c2'
    )
  })

  it('renders nothing when no chats were recalled', () => {
    const { container } = render(<RecallSection data={{ chats: [] }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
