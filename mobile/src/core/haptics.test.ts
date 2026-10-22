import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { haptic, type HapticKind } from '@/core/haptics'

vi.mock('@capacitor/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: vi.fn(() => true) }
}))
vi.mock('@capacitor/haptics', async importOriginal => ({
  ...(await importOriginal<typeof import('@capacitor/haptics')>()),
  Haptics: {
    impact: vi.fn(async () => {}),
    notification: vi.fn(async () => {}),
    selectionStart: vi.fn(async () => {}),
    selectionChanged: vi.fn(async () => {}),
    selectionEnd: vi.fn(async () => {})
  }
}))

const plugin = vi.mocked(Haptics)

/** Every plugin call made, as [method, ...args]. */
function calls() {
  return (
    [
      'impact',
      'notification',
      'selectionStart',
      'selectionChanged',
      'selectionEnd'
    ] as const
  ).flatMap(method =>
    plugin[method].mock.calls.map(args => [method, ...args] as unknown[])
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true)
})

describe('haptic', () => {
  it.each<[HapticKind, unknown[][]]>([
    ['light', [['impact', { style: ImpactStyle.Light }]]],
    ['medium', [['impact', { style: ImpactStyle.Medium }]]],
    ['success', [['notification', { type: NotificationType.Success }]]],
    ['warning', [['notification', { type: NotificationType.Warning }]]],
    ['error', [['notification', { type: NotificationType.Error }]]]
  ])('%s makes one plugin call', (kind, expected) => {
    haptic(kind)
    expect(calls()).toEqual(expected)
  })

  it('selection starts a generator (iOS ignores a tick without one), ticks it, then releases it, in that order', () => {
    haptic('selection')
    expect(calls()).toEqual([
      ['selectionStart'],
      ['selectionChanged'],
      ['selectionEnd']
    ])
    const order = (
      ['selectionStart', 'selectionChanged', 'selectionEnd'] as const
    ).map(method => plugin[method].mock.invocationCallOrder[0])
    expect(order).toEqual([...order].sort((x, y) => x - y))
  })

  it('maps to the plugin values iOS reads', () => {
    haptic('light')
    haptic('warning')
    expect(plugin.impact).toHaveBeenCalledWith({ style: 'LIGHT' })
    expect(plugin.notification).toHaveBeenCalledWith({ type: 'WARNING' })
  })

  it('does nothing on the web', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false)
    for (const kind of [
      'light',
      'medium',
      'selection',
      'success',
      'warning',
      'error'
    ] as const)
      haptic(kind)
    expect(calls()).toEqual([])
  })

  it('returns nothing and swallows a plugin rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      plugin.impact.mockRejectedValueOnce(new Error('no haptics'))
      plugin.selectionStart.mockRejectedValueOnce(new Error('no haptics'))
      plugin.selectionChanged.mockRejectedValueOnce(new Error('no haptics'))
      plugin.selectionEnd.mockRejectedValueOnce(new Error('no haptics'))
      expect(haptic('light')).toBeUndefined()
      expect(haptic('selection')).toBeUndefined()
      // Let the rejections settle (and any unhandled one be reported).
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('swallows a plugin that throws instead of rejecting', () => {
    plugin.notification.mockImplementationOnce(() => {
      throw new Error('not implemented')
    })
    expect(() => haptic('error')).not.toThrow()
  })
})
