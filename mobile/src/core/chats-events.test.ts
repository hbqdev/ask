import { afterEach, describe, expect, it, vi } from 'vitest'

import { emitChatsChanged, onChatsChanged } from '@/core/chats-events'

const unsubscribers: Array<() => void> = []

function listen(fn = vi.fn()) {
  unsubscribers.push(onChatsChanged(fn))
  return fn
}

afterEach(() => {
  unsubscribers.splice(0).forEach(off => off())
  vi.restoreAllMocks()
})

describe('chats-changed events', () => {
  it('delivers the reason and chat id to every subscriber', () => {
    const a = listen()
    const b = listen()
    emitChatsChanged('created', 'c1')
    expect(a).toHaveBeenCalledWith('created', 'c1')
    expect(b).toHaveBeenCalledWith('created', 'c1')
  })

  it('delivers a reason without a chat id', () => {
    const a = listen()
    emitChatsChanged('cleared')
    expect(a).toHaveBeenCalledWith('cleared', undefined)
  })

  it('stops delivering after unsubscribe', () => {
    const a = vi.fn()
    const off = onChatsChanged(a)
    off()
    emitChatsChanged('deleted', 'c1')
    expect(a).not.toHaveBeenCalled()
  })

  it('keeps delivering to the others when one subscriber throws, and logs it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    listen(
      vi.fn(() => {
        throw new Error('broken screen')
      })
    )
    const b = listen()
    emitChatsChanged('updated', 'c2')
    expect(b).toHaveBeenCalledWith('updated', 'c2')
    expect(error).toHaveBeenCalled()
  })

  it('lets a subscriber unsubscribe while being delivered to', () => {
    const later = vi.fn()
    const off = onChatsChanged(() => off())
    listen(later)
    emitChatsChanged('updated')
    expect(later).toHaveBeenCalledTimes(1)
    emitChatsChanged('updated')
    expect(later).toHaveBeenCalledTimes(2)
  })
})
