import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FIRST_RENDER_MARK,
  markFirstRender,
  resetFirstRenderMarkForTests
} from '@/app/launchMark'

beforeEach(() => {
  resetFirstRenderMarkForTests()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.mocked(console.log).mockRestore()
})

describe('markFirstRender', () => {
  it('logs the mark with the page clock and the wall clock', () => {
    markFirstRender(
      () => 123.456,
      () => 1_700_000_000_000
    )
    expect(console.log).toHaveBeenCalledWith(
      `${FIRST_RENDER_MARK} 123.5 1700000000000`
    )
  })

  it('logs once however often it is called', () => {
    markFirstRender()
    markFirstRender()
    expect(console.log).toHaveBeenCalledTimes(1)
  })

  it('uses performance.now() and Date.now() by default', () => {
    vi.spyOn(performance, 'now').mockReturnValue(42)
    vi.spyOn(Date, 'now').mockReturnValue(7)
    markFirstRender()
    expect(console.log).toHaveBeenCalledWith(`${FIRST_RENDER_MARK} 42.0 7`)
    vi.mocked(performance.now).mockRestore()
    vi.mocked(Date.now).mockRestore()
  })
})
