import React from 'react'

import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { sanitizeStoppedMessage } from '@/lib/streaming/helpers/sanitize-stopped-message'
import {
  buildUIMessageFromDB,
  mapUIMessageToDBMessage
} from '@/lib/utils/message-mapping'

import { MessageActions } from '../message-actions'

vi.mock('@/lib/actions/notes', () => ({ saveNote: vi.fn() }))
vi.mock('@/lib/analytics/posthog-client', () => ({ captureClient: vi.fn() }))
vi.mock('../library/library-context', () => ({
  useLibrary: () => ({ openLibrary: vi.fn(), upsertCachedNote: vi.fn() })
}))
vi.mock('../voice/speak-button', () => ({ SpeakButton: () => null }))
vi.mock('../chat-share', () => ({ ChatShare: () => null }))
vi.mock('../retry-button', () => ({
  RetryButton: () => <button type="button">retry</button>
}))

describe('MessageActions — Stopped badge', () => {
  test('renders a muted Stopped badge for a stopped answer', () => {
    render(<MessageActions message="partial answer" messageId="m1" stopped />)
    const badge = screen.getByTestId('stopped-badge')
    expect(badge.textContent).toContain('Stopped')
    expect(badge.className).toContain('text-muted-foreground')
    expect(badge.getAttribute('title')).toMatch(/stopped this answer/i)
  })

  test('renders no badge for a normal answer', () => {
    render(<MessageActions message="full answer" messageId="m2" />)
    expect(screen.queryByTestId('stopped-badge')).toBeNull()
  })

  test('the stopped flag survives the persist -> reload round trip', () => {
    // What a reload renders from: sanitize (server, on Stop) -> DB row ->
    // buildUIMessageFromDB -> AnswerSection reads metadata.stopped.
    const stopped = sanitizeStoppedMessage({
      id: 'a1',
      role: 'assistant',
      metadata: { traceId: 't' },
      parts: [{ type: 'text', text: 'Partial', state: 'streaming' }]
    } as any)!
    const row = mapUIMessageToDBMessage({ ...stopped, chatId: 'c1' } as any)
    const reloaded = buildUIMessageFromDB(
      { id: row.id, role: row.role, metadata: row.metadata },
      []
    )
    expect((reloaded.metadata as { stopped?: boolean })?.stopped).toBe(true)
  })
})
