// Share to Ask: the iOS Share extension (ios/App/AskShare) writes what
// another app shares (text, a link or both) into the App Group's inbox, and
// the native SharedInbox plugin (ios/App/App/SharedInboxPlugin.swift) hands
// it over once: take() reads and clears it in one step, so the item lands in
// the composer once however many times the app asks. Like an ask:// link it
// only fills the box (AskHome); it never sends by itself.
import { App } from '@capacitor/app'
import { registerPlugin } from '@capacitor/core'
import { useEffect, useRef } from 'react'

/** What the inbox holds: nothing, or the shared text and when it was shared (ms). */
export interface SharedInboxItem {
  text?: string
  createdAt?: number
}

interface SharedInboxPlugin {
  /** The waiting item, removed from the inbox; {} when there is none. */
  take(): Promise<SharedInboxItem>
}

// Off iOS (the browser preview, tests) nothing is ever shared to the app.
const SharedInbox = registerPlugin<SharedInboxPlugin>('SharedInbox', {
  web: { take: async () => ({}) }
})

/** An item older than this was shared for an earlier moment and is dropped. */
export const SHARED_ITEM_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The longest text that reaches the box, as for an ask:// link. */
const MAX_SHARED_CHARS = 2000

/**
 * Takes the waiting shared item: its text (trimmed, at most 2000 characters),
 * or null when the inbox is empty, the item is over 24 hours old or the
 * native side has no inbox.
 */
export async function takeSharedItem(): Promise<string | null> {
  let item: SharedInboxItem
  try {
    item = await SharedInbox.take()
  } catch {
    return null
  }
  const text = item.text?.trim().slice(0, MAX_SHARED_CHARS)
  if (!text || typeof item.createdAt !== 'number') return null
  if (Date.now() - item.createdAt > SHARED_ITEM_MAX_AGE_MS) return null
  return text
}

/**
 * Calls onText with the text of each item shared to Ask: one waiting when
 * the screen mounts, and one shared while the app was away, each time the
 * app becomes active again.
 */
export function useSharedItem(onText: (text: string) => void) {
  // The latest callback, so the listener is added once.
  const latest = useRef(onText)
  useEffect(() => {
    latest.current = onText
  }, [onText])

  useEffect(() => {
    const check = () =>
      void takeSharedItem().then(text => {
        if (text) latest.current(text)
      })
    check()
    const handle = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) check()
    })
    return () => {
      void handle.then(h => h.remove())
    }
  }, [])
}
