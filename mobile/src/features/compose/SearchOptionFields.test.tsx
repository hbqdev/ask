import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { haptic } from '@/core/haptics'
import {
  SearchModeField,
  SourcesField
} from '@/features/compose/SearchOptionFields'
import type { SearchSettings } from '@/features/thread/chat-body'

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

const SETTINGS: SearchSettings = { searchMode: 'balanced', sources: ['web'] }

beforeEach(() => vi.mocked(haptic).mockClear())

describe('SearchModeField haptics', () => {
  it('choosing another mode ticks selection, once', () => {
    const onSettings = vi.fn()
    render(<SearchModeField settings={SETTINGS} onSettings={onSettings} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Quality' }))
    expect(onSettings).toHaveBeenCalledTimes(1)
    expect(haptic).toHaveBeenCalledExactlyOnceWith('selection')
  })

  it('a tap on the mode already chosen makes none', () => {
    render(<SearchModeField settings={SETTINGS} onSettings={vi.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Balanced' }))
    expect(haptic).not.toHaveBeenCalled()
  })
})

describe('SourcesField haptics', () => {
  it('turning a source on or off ticks selection, once each', () => {
    const onSettings = vi.fn()
    render(
      <SourcesField
        settings={{ ...SETTINGS, sources: ['web', 'academic'] }}
        onSettings={onSettings}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Social' }))
    expect(haptic).toHaveBeenCalledExactlyOnceWith('selection')
    fireEvent.click(screen.getByRole('button', { name: 'Academic' }))
    expect(haptic).toHaveBeenCalledTimes(2)
    expect(onSettings).toHaveBeenCalledTimes(2)
  })

  it('a tap on the last source left, which cannot turn off, makes none', () => {
    const onSettings = vi.fn()
    render(<SourcesField settings={SETTINGS} onSettings={onSettings} />)
    fireEvent.click(screen.getByRole('button', { name: 'Web' }))
    expect(onSettings).not.toHaveBeenCalled()
    expect(haptic).not.toHaveBeenCalled()
  })
})
