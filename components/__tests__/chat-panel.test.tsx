import React from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  // Shows the key it is given and picks 'ollama:picked' on click, like the
  // real selector's controlled mode.
  ModelSelectorClient: ({
    data,
    selectedModelKey,
    onSelectedModelKeyChange
  }: {
    data: { selectedModelKey: string }
    selectedModelKey?: string
    onSelectedModelKeyChange?: (key: string) => void
  }) => (
    <button
      type="button"
      data-testid="model-selector"
      onClick={() => onSelectedModelKeyChange?.('ollama:picked')}
    >
      {selectedModelKey ?? data.selectedModelKey}
    </button>
  )
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

// The empty-state Discover briefing fetches /api/discover on mount, which
// would be counted by the ingest-polling tests' fetch mocks (and break on a
// mock that resolves to undefined). It is not under test here.
vi.mock('../discover-briefing', () => ({
  DiscoverBriefing: () => null
}))

// The homepage three-body canvas animation needs a 2D canvas context, which
// jsdom does not implement. Purely decorative, so stub it out.
vi.mock('../ui/wild-breath-field', () => ({
  WildBreathField: () => null
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

describe('ChatPanel model pick', () => {
  const modelSelectorData = {
    enabled: true,
    hasAvailableModels: true,
    modelsByProvider: {},
    selectedModelKey: 'ollama:page-load'
  } as unknown as React.ComponentProps<typeof ChatPanel>['modelSelectorData']

  test('keeps the picked model when the first message moves the composer', () => {
    const view = renderChatPanel({ modelSelectorData, messages: [] })
    fireEvent.click(screen.getByTestId('model-selector'))
    expect(screen.getByTestId('model-selector').textContent).toBe(
      'ollama:picked'
    )

    // The first message re-renders the composer in the thread layout, which
    // mounts a new selector: it must still show the pick, not the page-load
    // model the server sent before the pick.
    view.rerender(
      <ChatPanel
        chatId="chat-1"
        input=""
        handleInputChange={vi.fn()}
        handleSubmit={vi.fn()}
        status="streaming"
        messages={[
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }
        ]}
        setMessages={vi.fn()}
        stop={vi.fn()}
        append={vi.fn()}
        showScrollToBottomButton={false}
        scrollContainerRef={React.createRef<HTMLDivElement>()}
        uploadedFiles={[]}
        setUploadedFiles={vi.fn()}
        quotedContexts={[]}
        setQuotedContexts={vi.fn()}
        modelSelectorData={modelSelectorData}
      />
    )
    expect(screen.getByTestId('model-selector').textContent).toBe(
      'ollama:picked'
    )
  })

  test('shows the server pick until the user picks', () => {
    renderChatPanel({ modelSelectorData, messages: [] })
    expect(screen.getByTestId('model-selector').textContent).toBe(
      'ollama:page-load'
    )
  })
})
