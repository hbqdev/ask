import React from 'react'

import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { UploadedFile } from '@/lib/types'
import { deleteCookie, getCookie, setCookie } from '@/lib/utils/cookies'

import { ChatPanel } from '../chat-panel'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() })
}))

vi.mock('../artifact/artifact-context', () => ({
  useArtifact: () => ({ close: vi.fn() })
}))

vi.mock('../action-buttons', () => ({
  ActionButtons: () => null
}))

vi.mock('../file-upload-button', () => ({
  FileUploadButton: () => null
}))

vi.mock('../message-navigation-dots', () => ({
  MessageNavigationDots: () => null
}))

vi.mock('../model-selector-client', () => ({
  ModelSelectorClient: () => null
}))

vi.mock('../uploaded-file-list', () => ({
  UploadedFileList: () => null
}))

vi.mock('../weather-widget', () => ({
  WeatherWidget: () => null
}))

vi.mock('../news-article-widget', () => ({
  NewsArticleWidget: () => null
}))

vi.mock('../ui/wild-breath-logo', () => ({
  WildBreathLogo: () => <div data-testid="logo" />,
  WildBreathGlyph: ({ className }: { className?: string }) => (
    <span className={className} data-testid="glyph" />
  )
}))

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteCookie('searchMode')
  })

  test('preserves and submits the initial query after resetting a stale adaptive cookie', async () => {
    const append = vi.fn()
    const onAdaptiveModeAuthRequired = vi.fn()
    setCookie('searchMode', 'adaptive')

    render(
      <ChatPanel
        chatId="chat-1"
        input=""
        handleInputChange={vi.fn()}
        handleSubmit={vi.fn()}
        status="ready"
        messages={[]}
        setMessages={vi.fn()}
        query="latest news"
        stop={vi.fn()}
        append={append}
        showScrollToBottomButton={false}
        scrollContainerRef={React.createRef<HTMLDivElement>()}
        uploadedFiles={[]}
        setUploadedFiles={vi.fn()}
        quotedContexts={[]}
        setQuotedContexts={vi.fn()}
        isGuest
        isCloudDeployment
        onAdaptiveModeAuthRequired={onAdaptiveModeAuthRequired}
      />
    )

    await waitFor(() => {
      expect(getCookie('searchMode')).toBe('speed')
    })
    await waitFor(() => {
      expect(append).toHaveBeenCalledWith({
        role: 'user',
        parts: [{ type: 'text', text: 'latest news' }]
      })
    })
    expect(onAdaptiveModeAuthRequired).not.toHaveBeenCalled()
  })
})

function renderChatPanel(
  overrides: Partial<React.ComponentProps<typeof ChatPanel>>
) {
  return render(
    <ChatPanel
      chatId="chat-1"
      input=""
      handleInputChange={vi.fn()}
      handleSubmit={vi.fn()}
      status="ready"
      messages={[]}
      setMessages={vi.fn()}
      stop={vi.fn()}
      append={vi.fn()}
      showScrollToBottomButton={false}
      scrollContainerRef={React.createRef<HTMLDivElement>()}
      uploadedFiles={[]}
      setUploadedFiles={vi.fn()}
      quotedContexts={[]}
      setQuotedContexts={vi.fn()}
      {...overrides}
    />
  )
}

describe('ChatPanel ingest status polling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('polls the status route every 5s while a file is pending and merges the result', async () => {
    const setUploadedFiles = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        statuses: [
          {
            objectKey: 'u1/chats/c1/a.txt',
            status: 'ready',
            ingestStage: null,
            ingestError: null
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const pendingFile: UploadedFile = {
      status: 'uploaded',
      name: 'a.txt',
      objectKey: 'u1/chats/c1/a.txt',
      ingestStatus: 'pending'
    }

    renderChatPanel({
      uploadedFiles: [pendingFile],
      setUploadedFiles
    })

    expect(fetchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain(
      encodeURIComponent('u1/chats/c1/a.txt')
    )
    expect(setUploadedFiles).toHaveBeenCalledTimes(1)

    // Apply the functional updater the component passed to setUploadedFiles
    // to confirm the merge shape (status -> ingestStatus, plus stage/error).
    const updater = setUploadedFiles.mock.calls[0][0]
    const next = updater([pendingFile])
    expect(next).toEqual([
      {
        ...pendingFile,
        ingestStatus: 'ready',
        ingestStage: null,
        ingestError: null
      }
    ])
  })

  test('does not poll when no file is pending or processing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    renderChatPanel({
      uploadedFiles: [
        {
          status: 'uploaded',
          name: 'a.txt',
          objectKey: 'u1/chats/c1/a.txt',
          ingestStatus: 'ready'
        }
      ],
      setUploadedFiles: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(15000)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a failed poll fetch does not throw and leaves the interval running', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    renderChatPanel({
      uploadedFiles: [
        {
          status: 'uploaded',
          name: 'a.txt',
          objectKey: 'u1/chats/c1/a.txt',
          ingestStatus: 'processing'
        }
      ],
      setUploadedFiles: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The interval must still be alive after a failed poll.
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
