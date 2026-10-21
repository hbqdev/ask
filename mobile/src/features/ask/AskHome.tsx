// The Ask tab: the mark, "Ask anything" and the composer. A question, typed
// here or arriving as an ask:// link, opens a new thread that asks it.

import { useCallback } from 'react'

import { useAskDeepLink } from '@/core/deep-link'
import { useStack } from '@/core/nav/stack'
import { OrbitMark } from '@/core/ui/OrbitMark'
import { Composer } from '@/features/compose/Composer'
import { useSharedSearchSettings } from '@/features/compose/SearchSettingsProvider'
import { openThread } from '@/features/thread/ThreadScreen'

export function AskHome() {
  const { push } = useStack()
  const [settings, setSettings] = useSharedSearchSettings()

  const ask = useCallback(
    (question: string) => openThread(push, { question }),
    [push]
  )
  useAskDeepLink(ask)

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
      />
    </main>
  )
}
