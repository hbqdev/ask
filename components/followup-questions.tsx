'use client'

import {
  IconArrowRight as ArrowRight,
  IconRepeat as Repeat2
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { captureClient, chatIdFromPath } from '@/lib/analytics/posthog-client'
import { useChatContext } from '@/lib/contexts/chat-context'

import { Button } from './ui/button'

const MAX_QUESTIONS = 3

function currentChatId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return chatIdFromPath(window.location.pathname)
}

type FollowupQuestionsProps = {
  questions: string[]
}

/**
 * The "Related" follow-up questions under an answer. Same look as the
 * model-written Related spec block (SpecBlock's Heading + link Buttons) and
 * the same send path as its submitQuery handler.
 */
export function FollowupQuestions({ questions }: FollowupQuestionsProps) {
  const chatContext = useChatContext()
  const shown = questions
    .filter(q => typeof q === 'string' && q.trim())
    .slice(0, MAX_QUESTIONS)
  if (shown.length === 0) return null

  const submit = (query: string) => {
    // A second sendMessage mid-stream corrupts useChat's state and leaves
    // the input stuck disabled (see SpecBlock.submitQuery).
    if (chatContext.isStreamingRef.current) {
      toast.info('Please wait for the current response to finish.')
      return
    }

    captureClient('related_question_clicked', { chatId: currentChatId() })

    chatContext.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: query }]
    })
  }

  return (
    <div className="pt-2 pb-4" data-testid="followup-questions">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-lg font-bold text-foreground">
          <Repeat2 className="size-5" />
          Related
        </div>
        <div className="flex flex-col gap-1">
          {shown.map(question => (
            <Button
              key={question}
              type="button"
              variant="link"
              onClick={() => submit(question)}
              className="gap-2 h-auto w-fit justify-start whitespace-normal text-left px-0 py-0.5 font-semibold text-accent-foreground/50 hover:text-accent-foreground/70"
            >
              <ArrowRight className="size-4 shrink-0" />
              {question}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
