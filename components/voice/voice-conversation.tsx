'use client'

import { useMemo, useState } from 'react'

import { useChat } from '@ai-sdk/react'
import { IconMicrophone, IconMicrophoneOff, IconX } from '@tabler/icons-react'
import { DefaultChatTransport } from 'ai'

import { generateId } from '@/lib/db/schema'
import type { SearchResultItem } from '@/lib/types'
import { createSpeechDetector } from '@/lib/voice/vad'

import { useSpeechPlayback } from '@/hooks/use-speech-playback'
import {
  type ChatStatus,
  useVoiceConversation
} from '@/hooks/use-voice-conversation'

import WildBreathField from '@/components/ui/wild-breath-field'

import { SourceFavicons } from '@/components/source-favicons'

// Tool parts whose `output.results` are citable sources — mirrors the citation
// stack used elsewhere (search/fetch and the synthetic documentRetrieval tool).
const CITABLE = new Set(['tool-search', 'tool-fetch', 'tool-documentRetrieval'])

// Field liveliness per conversation phase. Feeds WildBreathField's `intensity`
// (clamped to [0,1] internally): calm while idle/listening, energetic while the
// model thinks and speaks.
const INTENSITY: Record<string, number> = {
  idle: 0,
  listening: 0.5,
  transcribing: 0.5,
  thinking: 0.85,
  speaking: 1,
  error: 0.2
}

export function VoiceConversation({ onClose }: { onClose: () => void }) {
  // Fresh, self-owned thread. Persistence is server-side by chatId, so the
  // overlay never navigates or pushState — it just streams its own turns.
  const [chatId] = useState(generateId)
  const { speak, stop } = useSpeechPlayback()

  const { messages, status, sendMessage } = useChat({
    id: chatId,
    messages: [],
    transport: new DefaultChatTransport({
      api: '/api/chat',
      // Minimal authenticated-turn body. model/searchMode/sources are resolved
      // SERVER-side from cookies + defaults (see app/api/chat/route.ts) — they
      // are NOT request-body fields, so the voice UI sends none of them. `voice`
      // stays false so the server does not also emit the read-aloud gist part;
      // this loop condenses via /api/voice/gist instead.
      prepareSendMessagesRequest: ({ messages, trigger, messageId }) => ({
        body: {
          trigger,
          chatId,
          messageId,
          voice: false,
          message:
            trigger === 'submit-message'
              ? messages[messages.length - 1]
              : undefined,
          isNewChat: trigger === 'submit-message' && messages.length === 1
        }
      })
    }),
    generateId
  })

  const assistant = useMemo(
    () => [...messages].reverse().find(m => m.role === 'assistant'),
    [messages]
  )
  const answerText = useMemo(
    () => assistant?.parts.filter(p => p.type === 'text').at(-1)?.text ?? '',
    [assistant]
  )
  const sources = useMemo<SearchResultItem[]>(() => {
    if (!assistant) return []
    const seen = new Set<string>()
    return assistant.parts
      .filter((p: any) => CITABLE.has(p.type) && p.state === 'output-available')
      .flatMap((p: any) => p.output?.results ?? [])
      .filter((r: any) => r?.url && !seen.has(r.url) && seen.add(r.url))
  }, [assistant])

  // Only hand the hook a finished answer: while streaming, `status` is not
  // 'ready', so the loop waits for the complete text before condensing/speaking.
  const answer = useMemo(
    () =>
      status === 'ready' && assistant && answerText
        ? { key: assistant.id, text: answerText }
        : null,
    [status, assistant, answerText]
  )

  const conv = useVoiceConversation(true, {
    createDetector: cb => createSpeechDetector(cb),
    transcribe: async (wav, signal) => {
      const fd = new FormData()
      fd.append('file', wav, 'turn.wav')
      const r = await fetch('/api/voice/transcribe', {
        method: 'POST',
        body: fd,
        signal
      })
      if (!r.ok) return ''
      const { text } = await r.json()
      return typeof text === 'string' ? text : ''
    },
    condense: async (text, signal) => {
      const r = await fetch('/api/voice/gist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal
      })
      if (!r.ok) return ''
      const { text: gist } = await r.json()
      return typeof gist === 'string' ? gist : ''
    },
    speak,
    stopSpeaking: stop,
    submit: text =>
      sendMessage({ role: 'user', parts: [{ type: 'text', text }] }),
    chatStatus: status as ChatStatus,
    answer
  })

  const handleEnd = () => {
    conv.end()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-xl">
      <WildBreathField
        className="pointer-events-none absolute inset-0"
        intensity={INTENSITY[conv.phase] ?? 0}
      />
      <div className="relative z-10 flex w-full max-w-2xl flex-col items-center gap-6 px-6 text-center">
        <p
          aria-live="polite"
          className="min-h-6 text-sm uppercase tracking-widest text-muted-foreground"
        >
          {conv.errorText ?? conv.phase}
        </p>
        {conv.transcript && (
          <p className="text-lg text-foreground/90">{conv.transcript}</p>
        )}
        {answerText && (
          <div className="max-h-[40vh] w-full overflow-y-auto rounded-2xl bg-card/60 p-4 text-left">
            <p className="whitespace-pre-wrap text-sm text-foreground/90">
              {answerText}
            </p>
            {sources.length > 0 && (
              <div className="mt-3">
                <SourceFavicons results={sources} />
              </div>
            )}
          </div>
        )}
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => conv.setMuted(!conv.muted)}
            aria-label={conv.muted ? 'Unmute microphone' : 'Mute microphone'}
            className="flex size-11 items-center justify-center rounded-full bg-card/70 text-foreground ring-1 ring-border"
          >
            {conv.muted ? (
              <IconMicrophoneOff className="size-5" />
            ) : (
              <IconMicrophone className="size-5" />
            )}
          </button>
          {/* End works in EVERY phase (including a terminal `error`), so the
              user can always close the overlay — reopening is the retry path. */}
          <button
            type="button"
            onClick={handleEnd}
            aria-label="End conversation"
            className="flex h-11 items-center gap-2 rounded-full bg-destructive px-5 text-destructive-foreground"
          >
            <IconX className="size-5" /> End
          </button>
        </div>
      </div>
    </div>
  )
}
