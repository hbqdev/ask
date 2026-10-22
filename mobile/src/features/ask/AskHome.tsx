// The Ask tab: the mark, "Ask anything" and the composer. A typed question
// (with any attached files) opens a new thread that asks it; an ask:// link
// or an item shared from another app (Share to Ask) only fills the box. The
// next chat's id is made up front, so attachments upload under the chat they
// will be asked in, as on the web.

import { useCallback, useState } from 'react'

import { useSelectTab } from '@/app/Tabs'
import { isE2eAutoSend } from '@/core/config'
import { useAskDeepLink } from '@/core/deep-link'
import { newId } from '@/core/ids'
import { useStack } from '@/core/nav/stack'
import { useSharedItem } from '@/core/shared-inbox'
import { READABLE } from '@/core/ui/classes'
import { OrbitMark } from '@/core/ui/OrbitMark'
import { useE2eAsk } from '@/features/ask/e2e-ask'
import { Composer } from '@/features/compose/Composer'
import { useSharedSearchSettings } from '@/features/compose/SearchSettingsProvider'
import type { FilePart } from '@/features/thread/chat-body'
import { openThread } from '@/features/thread/ThreadScreen'

export function AskHome() {
  const { push, screens, reset } = useStack()
  const selectTab = useSelectTab()
  const [settings, setSettings, settingsLoaded] = useSharedSearchSettings()
  const [draft, setDraft] = useState<{ text: string; append?: boolean }>()
  const [chatId, setChatId] = useState(newId)

  const ask = useCallback(
    (question: string, files?: FilePart[]) => {
      openThread(push, { question, files, newChatId: chatId })
      setChatId(newId())
    },
    [push, chatId]
  )

  // A link never sends by itself: a turn can write a lasting memory (the
  // `remember` tool), so any app or QR code could plant one. It brings the
  // user back to this screen with the question in the box, for them to send.
  // Simulator E2E builds send at once.
  // Back to this screen, on the Ask tab, with the text in the box.
  const fill = (text: string, append = false) => {
    if (screens.length > 1) reset(screens[0])
    selectTab?.('ask')
    setDraft({ text, append })
  }
  useAskDeepLink(question => {
    if (isE2eAutoSend()) return ask(question)
    fill(question)
  })
  // The same for an item shared to Ask (never sent, even in an E2E build),
  // added under any question already being typed rather than replacing it.
  useSharedItem(text => fill(text, true))
  useE2eAsk(ask, { ready: settingsLoaded })

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div
        className={`${READABLE} flex flex-1 flex-col items-center justify-center gap-4 px-6`}
      >
        <OrbitMark className="size-14" />
        <h1 className="text-2xl font-semibold tracking-tight">Ask anything</h1>
      </div>
      <Composer
        placeholder="Ask a question"
        // Nothing runs on the home screen, so there is nothing to stop.
        busy={false}
        onSend={ask}
        chatId={chatId}
        settings={settings}
        onSettings={setSettings}
        draft={draft}
        onTabBar
      />
    </main>
  )
}
