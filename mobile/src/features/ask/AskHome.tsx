// The Ask tab: the mark, "Ask anything" and the composer. A typed question
// opens a new thread that asks it; an ask:// link only fills the box.

import { useCallback, useState } from 'react'

import { useSelectTab } from '@/app/Tabs'
import { isE2eAutoSend } from '@/core/config'
import { useAskDeepLink } from '@/core/deep-link'
import { useStack } from '@/core/nav/stack'
import { OrbitMark } from '@/core/ui/OrbitMark'
import { useE2eAsk } from '@/features/ask/e2e-ask'
import { Composer } from '@/features/compose/Composer'
import { useSharedSearchSettings } from '@/features/compose/SearchSettingsProvider'
import { openThread } from '@/features/thread/ThreadScreen'

export function AskHome() {
  const { push, screens, reset } = useStack()
  const selectTab = useSelectTab()
  const [settings, setSettings, settingsLoaded] = useSharedSearchSettings()
  const [draft, setDraft] = useState<{ text: string }>()

  const ask = useCallback(
    (question: string) => openThread(push, { question }),
    [push]
  )

  // A link never sends by itself: a turn can write a lasting memory (the
  // `remember` tool), so any app or QR code could plant one. It brings the
  // user back to this screen with the question in the box, for them to send.
  // Simulator E2E builds send at once.
  useAskDeepLink(question => {
    if (isE2eAutoSend()) return ask(question)
    if (screens.length > 1) reset(screens[0])
    selectTab?.('ask')
    setDraft({ text: question })
  })
  useE2eAsk(ask, { ready: settingsLoaded })

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
        <OrbitMark className="size-14" />
        <h1 className="text-2xl font-semibold tracking-tight">Ask anything</h1>
      </div>
      <Composer
        placeholder="Ask a question"
        // Nothing runs on the home screen, so there is nothing to stop.
        busy={false}
        onSend={ask}
        settings={settings}
        onSettings={setSettings}
        draft={draft}
      />
    </main>
  )
}
