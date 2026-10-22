import { afterEach, describe, expect, it } from 'vitest'

import { requestLightStatusBar } from '@/core/ui/status-bar'

const attribute = () => document.documentElement.getAttribute('data-status-bar')

afterEach(() => {
  document.documentElement.removeAttribute('data-status-bar')
})

describe('requestLightStatusBar', () => {
  it('one request sets the attribute and its release clears it', () => {
    expect(attribute()).toBeNull()
    const release = requestLightStatusBar()
    expect(attribute()).toBe('light')
    release()
    expect(attribute()).toBeNull()
  })

  it('two overlapping requests clear only after both release', () => {
    const first = requestLightStatusBar()
    const second = requestLightStatusBar()
    first()
    expect(attribute()).toBe('light')
    second()
    expect(attribute()).toBeNull()
  })

  it('a double release does not underflow', () => {
    const first = requestLightStatusBar()
    const second = requestLightStatusBar()
    first()
    first()
    // The second request still holds it.
    expect(attribute()).toBe('light')
    second()
    expect(attribute()).toBeNull()
    // And a later request still sets it.
    const third = requestLightStatusBar()
    expect(attribute()).toBe('light')
    third()
    expect(attribute()).toBeNull()
  })
})
