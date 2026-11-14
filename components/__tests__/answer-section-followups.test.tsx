import React from 'react'

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/actions/notes', () => ({ saveNote: vi.fn() }))
vi.mock('@/lib/analytics/posthog-client', () => ({ captureClient: vi.fn() }))
vi.mock('../library/library-context', () => ({
  useLibrary: () => ({ openLibrary: vi.fn(), upsertCachedNote: vi.fn() })
}))
vi.mock('../message', () => ({
  MarkdownMessage: ({ message }: { message: string }) => <div>{message}</div>
}))
vi.mock('../message-actions', () => ({
  MessageActions: () => <div data-testid="message-actions" />
}))
vi.mock('../followup-questions', () => ({
  FollowupQuestions: ({ questions }: { questions: string[] }) => (
    <div data-testid="followups">{questions.join('|')}</div>
  )
}))

import { AnswerSection } from '../answer-section'

const RELATED_SPEC = [
  '```spec',
  '{"op":"add","path":"/root","value":"main"}',
  '{"op":"add","path":"/elements/main","value":{"type":"Stack","props":{},"children":["q1"]}}',
  '{"op":"add","path":"/elements/q1","value":{"type":"Button","props":{"text":"Old?"},"children":[]}}',
  '```'
].join('\n')

function renderSection(
  props: Partial<React.ComponentProps<typeof AnswerSection>> = {}
) {
  return render(
    <AnswerSection
      content="## Answer"
      isOpen
      onOpenChange={() => {}}
      messageId="m1"
      {...props}
    />
  )
}

describe('AnswerSection follow-ups', () => {
  it('renders the follow-ups from metadata', () => {
    renderSection({ metadata: { followups: ['a?', 'b?'] } })
    expect(screen.getByTestId('followups').textContent).toBe('a?|b?')
  })

  it('renders none without metadata.followups', () => {
    renderSection({ metadata: {} })
    expect(screen.queryByTestId('followups')).toBeNull()
  })

  it('hides them while this message is streaming (actions hidden)', () => {
    renderSection({ metadata: { followups: ['a?'] }, showActions: false })
    expect(screen.queryByTestId('followups')).toBeNull()
  })

  it('does not double up on an answer with a model-written Related block', () => {
    renderSection({
      content: '## Answer\n\n' + RELATED_SPEC,
      metadata: { followups: ['a?'] }
    })
    expect(screen.queryByTestId('followups')).toBeNull()
  })
})
