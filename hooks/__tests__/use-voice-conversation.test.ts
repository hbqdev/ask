import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useVoiceConversation,
  type VoiceConversationDeps
} from '@/hooks/use-voice-conversation'

type EndCb = (pcm: Float32Array) => void

function makeDeps(over: Partial<VoiceConversationDeps> = {}) {
  const detector = { start: vi.fn(), pause: vi.fn(), destroy: vi.fn() }
  let onSpeechEnd: EndCb = () => {}
  const deps: VoiceConversationDeps = {
    createDetector: vi.fn(async cb => {
      onSpeechEnd = cb.onSpeechEnd
      return detector
    }),
    transcribe: vi.fn(async () => 'what is the capital of france'),
    condense: vi.fn(async () => 'Paris.'),
    speak: vi.fn(async () => {}),
    stopSpeaking: vi.fn(),
    submit: vi.fn(),
    chatStatus: 'ready',
    answer: null,
    ...over
  }
  return { deps, detector, fire: (pcm: Float32Array) => onSpeechEnd(pcm) }
}

beforeEach(() => {
  vi.useFakeTimers()
  // Testing Library's `waitFor` only advances a fake clock when it detects a
  // `jest` global (see @testing-library/dom helpers.js: jestFakeTimersAreEnabled).
  // Under Vitest that global is absent, so `waitFor` falls back to its frozen
  // real-timer poller and every assertion times out. Expose the one method it
  // calls (`jest.advanceTimersByTime`) so the poller can drive Vitest's fake
  // clock. Scaffolding only — no assertion intent changes.
  vi.stubGlobal('jest', {
    advanceTimersByTime: vi.advanceTimersByTime.bind(vi)
  })
})
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useVoiceConversation', () => {
  it('arms the detector and enters listening when active', async () => {
    const { deps, detector } = makeDeps()
    const { result } = renderHook(() => useVoiceConversation(true, deps))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    expect(detector.start).toHaveBeenCalled()
  })

  it('transcribes a turn and submits it, entering thinking', async () => {
    const { deps, detector, fire } = makeDeps()
    const { result } = renderHook(() => useVoiceConversation(true, deps))
    await waitFor(() => expect(result.current.phase).toBe('listening'))

    await act(async () => {
      fire(new Float32Array([0.2, 0.2, 0.2]))
    })
    await waitFor(() => expect(result.current.phase).toBe('thinking'))
    expect(detector.pause).toHaveBeenCalled()
    expect(deps.submit).toHaveBeenCalledWith('what is the capital of france')
    expect(result.current.transcript).toBe('what is the capital of france')
  })

  it('re-listens without submitting on a blank transcript', async () => {
    const { deps, fire } = makeDeps({ transcribe: vi.fn(async () => '   ') })
    const { result } = renderHook(() => useVoiceConversation(true, deps))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    await act(async () => fire(new Float32Array([0.1])))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('speaks the condensed answer then returns to listening', async () => {
    const base = makeDeps()
    const { result, rerender } = renderHook(
      ({ d }: { d: VoiceConversationDeps }) => useVoiceConversation(true, d),
      { initialProps: { d: base.deps } }
    )
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    await act(async () => base.fire(new Float32Array([0.2, 0.2])))
    await waitFor(() => expect(result.current.phase).toBe('thinking'))

    // answer streams in
    rerender({ d: { ...base.deps, chatStatus: 'ready', answer: { key: 'm1', text: 'The capital is Paris.' } } })
    await waitFor(() => expect(base.deps.condense).toHaveBeenCalledWith('The capital is Paris.', expect.anything()))
    await waitFor(() => expect(base.deps.speak).toHaveBeenCalledWith('Paris.'))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
  })

  it('shows an error then re-listens when the chat errors', async () => {
    const base = makeDeps()
    const { result, rerender } = renderHook(
      ({ d }: { d: VoiceConversationDeps }) => useVoiceConversation(true, d),
      { initialProps: { d: base.deps } }
    )
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    await act(async () => base.fire(new Float32Array([0.2])))
    await waitFor(() => expect(result.current.phase).toBe('thinking'))

    rerender({ d: { ...base.deps, chatStatus: 'error', answer: null } })
    await waitFor(() => expect(result.current.phase).toBe('error'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(result.current.phase).toBe('listening')
  })

  it('still re-listens when the effect re-runs during the error hold', async () => {
    const base = makeDeps()
    const { result, rerender } = renderHook(
      ({ d }: { d: VoiceConversationDeps }) => useVoiceConversation(true, d),
      { initialProps: { d: base.deps } }
    )
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    await act(async () => base.fire(new Float32Array([0.2])))
    await waitFor(() => expect(result.current.phase).toBe('thinking'))

    rerender({ d: { ...base.deps, chatStatus: 'error', answer: null } })
    await waitFor(() => expect(result.current.phase).toBe('error'))

    // A re-render lands mid-hold (Task 6 derives `answer` as a fresh object each
    // render, so its identity changes). This forces the answer/error effect to
    // re-run while phase is already 'error'. The pending re-listen timer must
    // survive that re-run — not be cancelled by an effect cleanup.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    rerender({
      d: { ...base.deps, chatStatus: 'error', answer: { key: 'm9', text: 'x' } }
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600)
    })
    expect(result.current.phase).toBe('listening')
  })

  it('tears down on end()', async () => {
    const { deps, detector } = makeDeps()
    const { result } = renderHook(() => useVoiceConversation(true, deps))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    act(() => result.current.end())
    expect(detector.destroy).toHaveBeenCalled()
    expect(deps.stopSpeaking).toHaveBeenCalled()
    expect(result.current.phase).toBe('idle')
  })

  it('ignores speech while muted', async () => {
    const { deps, detector, fire } = makeDeps()
    const { result } = renderHook(() => useVoiceConversation(true, deps))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    act(() => result.current.setMuted(true))
    expect(detector.pause).toHaveBeenCalled()
    await act(async () => fire(new Float32Array([0.2])))
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('listening')
  })
})
