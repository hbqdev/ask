import React from 'react'

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatProvider } from '@/lib/contexts/chat-context'

const toastInfo = vi.fn()
vi.mock('sonner', () => ({
  toast: { info: (...a: unknown[]) => toastInfo(...a) }
}))
const captureClient = vi.fn()
vi.mock('@/lib/analytics/posthog-client', () => ({
  captureClient: (...a: unknown[]) => captureClient(...a),
  chatIdFromPath: () => 'chat-x'
}))

import { FollowupQuestions } from '../followup-questions'

const QS = ['First question?', 'Second question?', 'Third question?']

function renderWith(questions: string[], streaming = false) {
  const sendMessage = vi.fn()
  const isStreamingRef = { current: streaming }
  const utils = render(
    <ChatProvider sendMessage={sendMessage} isStreamingRef={isStreamingRef}>
      <FollowupQuestions questions={questions} />
    </ChatProvider>
  )
  return { ...utils, sendMessage, isStreamingRef }
}

beforeEach(() => {
  toastInfo.mockReset()
  captureClient.mockReset()
})

describe('FollowupQuestions', () => {
  it('renders the Related heading and 3 buttons', () => {
    renderWith(QS)
    expect(screen.getByText('Related')).toBeTruthy()
    const buttons = screen.getAllByRole('button')
    expect(buttons.map(b => b.textContent)).toEqual(QS)
  })

  it('shows at most 3 questions', () => {
    renderWith([...QS, 'Fourth?'])
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.queryByText('Fourth?')).toBeNull()
  })

  it('renders nothing for []', () => {
    const { container } = renderWith([])
    expect(container.innerHTML).toBe('')
  })

  it('ignores blank questions', () => {
    const { container } = renderWith(['  ', ''])
    expect(container.innerHTML).toBe('')
  })

  it('a click sends the question', () => {
    const { sendMessage } = renderWith(QS)
    fireEvent.click(screen.getByText('Second question?'))
    expect(captureClient).toHaveBeenCalledWith('related_question_clicked', {
      chatId: 'chat-x'
    })
    expect(sendMessage).toHaveBeenCalledWith({
      role: 'user',
      parts: [{ type: 'text', text: 'Second question?' }]
    })
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('a click while streaming shows the toast and does not send', () => {
    const { sendMessage } = renderWith(QS, true)
    fireEvent.click(screen.getByText('First question?'))
    expect(toastInfo).toHaveBeenCalledWith(
      'Please wait for the current response to finish.'
    )
    expect(sendMessage).not.toHaveBeenCalled()
    expect(captureClient).not.toHaveBeenCalled()
  })
})
