import { afterEach, describe, expect, it } from 'vitest'

import { requestLightStatusBar } from '@/core/ui/status-bar'

const attribute = () => document.documentElement.getAttribute('data-status-bar')

// Every hold a test takes is released after it, even one that failed before
// its own release: the count is module state, and a leaked hold would keep
// the attribute set in every later test.
const holds: Array<() => void> = []
function request() {
  const release = requestLightStatusBar()
  holds.push(release)
  return release
}

afterEach(() => {
  holds.splice(0).forEach(release => release())
  expect(attribute()).toBeNull()
})

describe('requestLightStatusBar', () => {
  it('one request sets the attribute and its release clears it', () => {
    expect(attribute()).toBeNull()
    const release = request()
    expect(attribute()).toBe('light')
    release()
    expect(attribute()).toBeNull()
  })

  it('two overlapping requests clear only after both release', () => {
    const first = request()
    const second = request()
    first()
    expect(attribute()).toBe('light')
    second()
    expect(attribute()).toBeNull()
  })

  it('a double release does not underflow', () => {
    const first = request()
    const second = request()
    first()
    first()
    // The second request still holds it.
    expect(attribute()).toBe('light')
    second()
    expect(attribute()).toBeNull()
    // And a later request still sets it.
    const third = request()
    expect(attribute()).toBe('light')
    third()
    expect(attribute()).toBeNull()
  })
})
