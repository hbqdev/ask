import { notFound, redirect } from 'next/navigation'

import { UIMessage } from 'ai'

import { loadChat, loadChatUncached } from '@/lib/actions/chat'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { getModelSelectorData } from '@/lib/model-selector/get-model-selector-data'

import { Chat } from '@/components/chat'

export const maxDuration = 60

export async function generateMetadata(props: {
  params: Promise<{ id: string }>
}) {
  const { id } = await props.params
  const userId = await getCurrentUserId()

  const chat = await loadChat(id, userId)

  if (!chat) {
    return { title: 'Search' }
  }

  return {
    title: chat.title.toString().slice(0, 50) || 'Search'
  }
}

export default async function SearchPage(props: {
  params: Promise<{ id: string }>
}) {
  const { id } = await props.params
  const userId = await getCurrentUserId()

  // Uncached on purpose. loadChat's unstable_cache is stale-while-revalidate
  // (its tag is revalidated with the 'max' profile), so the first read after a
  // turn is served the PREVIOUS snapshot: a reload right after an answer lost
  // that turn, a mid-stream reload resumed the live stream on top of the wrong
  // last message, and a read that raced a new chat's creation cached a miss
  // that then rendered a 404 for a chat that exists. The conversation shown here must
  // be the persisted one; it's one indexed query per page load. (Metadata
  // below keeps the cached read — a stale title is harmless.)
  const chat = await loadChatUncached(id, userId)

  if (!chat) {
    notFound()
  }

  if (chat.visibility === 'private' && !userId) {
    redirect('/auth/login')
  }

  const messages: UIMessage[] = chat.messages
  const isCloudDeployment = process.env.MORPHIC_CLOUD_DEPLOYMENT === 'true'
  const libraryAvailable = process.env.ENABLE_AUTH !== 'false'
  const modelSelectorData = await getModelSelectorData()

  return (
    <Chat
      key={id}
      id={id}
      savedMessages={messages}
      title={chat.title}
      isGuest={!userId}
      isCloudDeployment={isCloudDeployment}
      libraryAvailable={libraryAvailable}
      modelSelectorData={modelSelectorData}
    />
  )
}
