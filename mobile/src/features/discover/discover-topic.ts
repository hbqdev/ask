// Discover's chosen topic, kept across launches in Capacitor Preferences.

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import { TOPICS, type Topic } from '@/features/discover/discover-api'

/** The Preferences key that holds the topic, as its plain key. */
export const DISCOVER_TOPIC_KEY = 'ask-discover-topic'

/** A stored value as a topic; anything else is `tech`, the default. */
export function parseDiscoverTopic(value: string | null): Topic {
  return TOPICS.find(t => t.key === value)?.key ?? 'tech'
}

/**
 * The topic, a setter, and whether it has loaded. It starts on `tech` and
 * moves to the stored topic once that loads (or stays on `tech` when storage
 * cannot be read). A change shows at once and is saved in the background; a
 * failed save only costs the change at the next launch.
 */
export function useDiscoverTopic(
  storage: AuthStorage = preferencesStorage
): [Topic, (topic: Topic) => void, boolean] {
  const [topic, setTopicState] = useState<Topic>('tech')
  const [loaded, setLoaded] = useState(false)
  // Set once the user picks a topic, so a slow load cannot undo it.
  const changed = useRef(false)

  useEffect(() => {
    storage
      .getItem(DISCOVER_TOPIC_KEY)
      .then(value => {
        if (!changed.current) setTopicState(parseDiscoverTopic(value))
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [storage])

  const setTopic = useCallback(
    (next: Topic) => {
      changed.current = true
      setTopicState(next)
      storage.setItem(DISCOVER_TOPIC_KEY, next).catch(() => {})
    },
    [storage]
  )

  return [topic, setTopic, loaded]
}
