'use client'

import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useContext,
  useState
} from 'react'

export type ChatHeaderInfo = { chatId: string; title?: string } | null

type ChatHeaderContextValue = {
  info: ChatHeaderInfo
  setInfo: Dispatch<SetStateAction<ChatHeaderInfo>>
}

const ChatHeaderContext = createContext<ChatHeaderContextValue | null>(null)

// Lets an open chat publish its title/id up to the app-wide Header (which
// is rendered outside the chat's own component tree, in layout.tsx) so the
// chat title + its options menu can live in that always-on-top, full-width
// bar instead of a separate bar scrolling with the message list — a
// separate bar nested in the padded content column can't span full width
// or sit at a true fixed position without duplicating the sidebar-aware
// layout math Header already has.
export function ChatHeaderProvider({
  children
}: {
  children: React.ReactNode
}) {
  const [info, setInfo] = useState<ChatHeaderInfo>(null)

  return (
    <ChatHeaderContext.Provider value={{ info, setInfo }}>
      {children}
    </ChatHeaderContext.Provider>
  )
}

export function useChatHeaderInfo(): ChatHeaderContextValue {
  const context = useContext(ChatHeaderContext)
  if (!context) {
    throw new Error(
      'useChatHeaderInfo must be used within a ChatHeaderProvider'
    )
  }
  return context
}
