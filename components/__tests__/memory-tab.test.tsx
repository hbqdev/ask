import React from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null
}))
vi.mock('@/lib/actions/memory', () => ({
  getMemories: vi.fn(),
  getMemoryEnabled: vi.fn(),
  setMemoryEnabledAction: vi.fn(),
  deleteMemoryAction: vi.fn(),
  clearMemoriesAction: vi.fn()
}))
vi.mock('@/lib/actions/recall', () => ({
  getRecallEnabled: vi.fn(),
  getRecallStatus: vi.fn(),
  setRecallEnabledAction: vi.fn(),
  clearRecallIndexAction: vi.fn(),
  rebuildRecallIndexAction: vi.fn()
}))

import { getMemories, getMemoryEnabled } from '@/lib/actions/memory'
import { getRecallEnabled, getRecallStatus } from '@/lib/actions/recall'

import { MemoryTab } from '../settings/memory-tab'

const memory = {
  id: 'mem-1',
  userId: 'u1',
  content: 'Prefers concise answers.',
  category: 'preference',
  status: 'candidate',
  sightings: 1,
  embedding: [],
  sourceChatId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastUsedAt: null
} as any

function mockHappyPath() {
  vi.mocked(getMemoryEnabled).mockResolvedValue(true)
  vi.mocked(getMemories).mockResolvedValue([memory])
  vi.mocked(getRecallEnabled).mockResolvedValue(true)
  vi.mocked(getRecallStatus).mockResolvedValue({ chunks: 10, chats: 2 })
}

describe('MemoryTab initial load', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders memories when the load succeeds', async () => {
    mockHappyPath()
    render(<MemoryTab />)
    expect(
      await screen.findByText('Prefers concise answers.')
    ).toBeInTheDocument()
  })

  it('shows an explicit error (not an eternal spinner or a false empty state) when the load fails', async () => {
    // Stale-tab scenario: a tab from before a redeploy calls server actions
    // that no longer exist — every call rejects.
    vi.mocked(getMemoryEnabled).mockRejectedValue(new Error('stale action'))
    vi.mocked(getMemories).mockRejectedValue(new Error('stale action'))
    vi.mocked(getRecallEnabled).mockRejectedValue(new Error('stale action'))
    vi.mocked(getRecallStatus).mockRejectedValue(new Error('stale action'))

    render(<MemoryTab />)

    expect(
      await screen.findByText(/couldn't load memories/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/no memories yet/i)).not.toBeInTheDocument()
  })

  it('recovers via the Retry button once the backend is reachable again', async () => {
    vi.mocked(getMemoryEnabled).mockRejectedValueOnce(new Error('down'))
    vi.mocked(getMemories).mockRejectedValueOnce(new Error('down'))
    vi.mocked(getRecallEnabled).mockRejectedValueOnce(new Error('down'))
    vi.mocked(getRecallStatus).mockRejectedValueOnce(new Error('down'))
    mockHappyPath()

    render(<MemoryTab />)
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))

    await waitFor(() =>
      expect(screen.getByText('Prefers concise answers.')).toBeInTheDocument()
    )
    expect(
      screen.queryByText(/couldn't load memories/i)
    ).not.toBeInTheDocument()
  })
})
