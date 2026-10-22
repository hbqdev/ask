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

describe('SearchModeField look', () => {
  it('is a segmented control: the chosen mode is the thumb on a muted track', () => {
    render(<SearchModeField settings={SETTINGS} onSettings={vi.fn()} />)
    expect(screen.getByRole('radiogroup')).toHaveClass('bg-muted', 'rounded-xl')
    expect(screen.getByRole('radio', { name: 'Balanced' })).toHaveClass(
      'bg-thumb'
    )
    for (const name of ['Speed', 'Quality']) {
      const mode = screen.getByRole('radio', { name })
      expect(mode).not.toHaveClass('bg-thumb')
      expect(mode).toHaveClass('text-muted-foreground')
    }
  })

  it('titles the section like every other', () => {
    render(<SearchModeField settings={SETTINGS} onSettings={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Search mode' })).toHaveClass(
      'text-foreground/60'
    )
  })
})

describe('SourcesField look', () => {
  const settings: SearchSettings = { ...SETTINGS, sources: ['web', 'social'] }

  it('the sources are pills that wrap, each a toggle button', () => {
    render(<SourcesField settings={settings} onSettings={vi.fn()} />)
    const pills = screen.getAllByRole('button')
    expect(pills.map(p => p.textContent)).toEqual(['Web', 'Academic', 'Social'])
    expect(pills[0].parentElement).toHaveClass('flex', 'flex-wrap', 'gap-2')
    for (const pill of pills) {
      expect(pill).toHaveClass('rounded-full', 'px-4', 'min-h-11')
      expect(pill).not.toHaveClass('flex-1')
      expect(pill).toHaveAttribute('aria-pressed')
    }
  })

  it('a source that is on is an inverted chip with a check; one that is off is muted, with none', () => {
    render(<SourcesField settings={settings} onSettings={vi.fn()} />)
    const web = screen.getByRole('button', { name: 'Web' })
    const academic = screen.getByRole('button', { name: 'Academic' })
    expect(web).toHaveAttribute('aria-pressed', 'true')
    expect(web).toHaveClass('bg-foreground', 'text-background')
    const check = web.querySelector('svg')!
    expect(check).toHaveAttribute('aria-hidden', 'true')
    expect(check).toHaveClass('size-4')
    // Leading: before the label.
    expect(web.firstElementChild).toBe(check)
    expect(academic).toHaveAttribute('aria-pressed', 'false')
    expect(academic).toHaveClass('bg-muted', 'text-foreground')
    expect(academic.querySelector('svg')).toBeNull()
  })
})
