import { afterEach, describe, expect, it, vi } from 'vitest'

const youtubeMocks = vi.hoisted(() => {
  class YoutubeTranscriptNotAvailableLanguageError extends Error {
    lang: string
    availableLangs: string[]
    videoId: string
    constructor(lang: string, availableLangs: string[], videoId: string) {
      super(`No transcripts available in "${lang}"`)
      this.lang = lang
      this.availableLangs = availableLangs
      this.videoId = videoId
    }
  }
  return {
    fetchTranscript: vi.fn(),
    toPlainText: vi.fn((segments: { text: string }[], separator = '\n') =>
      segments.map(s => s.text).join(separator)
    ),
    YoutubeTranscriptNotAvailableLanguageError
  }
})

vi.mock('youtube-transcript-plus', () => youtubeMocks)

// fetchTool wraps everything with `logToolPayload`, which pulls in usage
// logging infra we don't need for these unit tests — no-op it.
vi.mock('@/lib/utils/usage-logging', () => ({
  logToolPayload: vi.fn()
}))

import { fetchYoutubeTranscriptData, isYoutubeUrl } from '../fetch'

describe('isYoutubeUrl', () => {
  it('matches standard watch URLs', () => {
    expect(isYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      true
    )
  })

  it('matches youtu.be short URLs', () => {
    expect(isYoutubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
  })

  it('matches shorts URLs', () => {
    expect(isYoutubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      true
    )
  })

  it('matches mobile youtube URLs', () => {
    expect(isYoutubeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
  })

  it('matches bare youtube.com URLs without www', () => {
    expect(isYoutubeUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
  })

  it('does not match ordinary web pages', () => {
    expect(isYoutubeUrl('https://example.com/article')).toBe(false)
  })

  it('does not match unrelated domains containing "youtube" as a substring', () => {
    expect(isYoutubeUrl('https://notyoutube.com/watch?v=x')).toBe(false)
  })
})

describe('fetchYoutubeTranscriptData', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns transcript text as the result content, joined by spaces', async () => {
    youtubeMocks.fetchTranscript.mockResolvedValue({
      videoDetails: {
        title: 'How Bicycles Work',
        author: 'Some Channel',
        lengthSeconds: 600
      },
      segments: [
        { text: 'Welcome to this video.', duration: 2, offset: 0, lang: 'en' },
        { text: 'Today we cover bikes.', duration: 2, offset: 2, lang: 'en' }
      ]
    })

    const result = await fetchYoutubeTranscriptData(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    )

    expect(result.results).toHaveLength(1)
    expect(result.results[0].title).toBe('How Bicycles Work')
    expect(result.results[0].content).toBe(
      'Welcome to this video. Today we cover bikes.'
    )
    expect(result.results[0].url).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    )
    expect(result.images).toEqual([])
  })

  it('requests English captions first', async () => {
    youtubeMocks.fetchTranscript.mockResolvedValue({
      videoDetails: { title: 'A Video' },
      segments: [{ text: 'hi', duration: 1, offset: 0, lang: 'en' }]
    })

    await fetchYoutubeTranscriptData('https://youtu.be/dQw4w9WgXcQ')

    expect(youtubeMocks.fetchTranscript).toHaveBeenCalledWith(
      'https://youtu.be/dQw4w9WgXcQ',
      { videoDetails: true, lang: 'en' }
    )
  })

  it('falls back to any available language when English captions do not exist', async () => {
    youtubeMocks.fetchTranscript
      .mockRejectedValueOnce(
        new youtubeMocks.YoutubeTranscriptNotAvailableLanguageError(
          'en',
          ['ar'],
          'dQw4w9WgXcQ'
        )
      )
      .mockResolvedValueOnce({
        videoDetails: { title: 'A Video' },
        segments: [{ text: 'مرحبا', duration: 1, offset: 0, lang: 'ar' }]
      })

    const result = await fetchYoutubeTranscriptData(
      'https://youtu.be/dQw4w9WgXcQ'
    )

    expect(youtubeMocks.fetchTranscript).toHaveBeenCalledTimes(2)
    expect(youtubeMocks.fetchTranscript).toHaveBeenNthCalledWith(
      2,
      'https://youtu.be/dQw4w9WgXcQ',
      { videoDetails: true }
    )
    expect(result.results[0].content).toBe('مرحبا')
  })

  it('truncates very long transcripts to the content character limit', async () => {
    const longText = 'word '.repeat(20000) // ~100,000 chars, over the 50,000 limit
    youtubeMocks.fetchTranscript.mockResolvedValue({
      videoDetails: { title: 'Long Video' },
      segments: [{ text: longText, duration: 6000, offset: 0, lang: 'en' }]
    })

    const result = await fetchYoutubeTranscriptData(
      'https://youtu.be/dQw4w9WgXcQ'
    )

    expect(result.results[0].content.length).toBeLessThanOrEqual(50000 + 15)
    expect(result.results[0].content.endsWith('...[truncated]')).toBe(true)
  })

  it('truncates very long titles to the title character limit', async () => {
    const longTitle = 'A'.repeat(200)
    youtubeMocks.fetchTranscript.mockResolvedValue({
      videoDetails: { title: longTitle },
      segments: [{ text: 'hi', duration: 1, offset: 0, lang: 'en' }]
    })

    const result = await fetchYoutubeTranscriptData(
      'https://youtu.be/dQw4w9WgXcQ'
    )

    expect(result.results[0].title.length).toBeLessThanOrEqual(103)
    expect(result.results[0].title.endsWith('...')).toBe(true)
  })

  it('falls back to the URL as title when videoDetails.title is missing', async () => {
    youtubeMocks.fetchTranscript.mockResolvedValue({
      videoDetails: {},
      segments: [{ text: 'hi', duration: 1, offset: 0, lang: 'en' }]
    })

    const result = await fetchYoutubeTranscriptData(
      'https://youtu.be/dQw4w9WgXcQ'
    )

    expect(result.results[0].title).toBe('https://youtu.be/dQw4w9WgXcQ')
  })

  it('propagates errors from fetchTranscript so callers can fall back', async () => {
    youtubeMocks.fetchTranscript.mockRejectedValue(
      new Error('Transcripts are disabled for this video')
    )

    await expect(
      fetchYoutubeTranscriptData('https://youtu.be/dQw4w9WgXcQ')
    ).rejects.toThrow('Transcripts are disabled for this video')
  })
})
