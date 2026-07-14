import React from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { deleteCookie, getCookie, setCookie } from '@/lib/utils/cookies'

import { SearchModeSelector } from '../search-mode-selector'

describe('SearchModeSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteCookie('searchMode')
  })

  test('blocks balanced/quality selection and resets to speed when auth is required', async () => {
    const onAdaptiveAuthRequired = vi.fn()
    setCookie('searchMode', 'speed')

    render(
      <SearchModeSelector
        isAdaptiveAuthRequired
        onAdaptiveAuthRequired={onAdaptiveAuthRequired}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Select search mode' }))
    fireEvent.click(screen.getByRole('button', { name: /Balanced/i }))

    expect(onAdaptiveAuthRequired).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(getCookie('searchMode')).toBe('speed')
    })
  })

  test('allows balanced selection when auth is not required', async () => {
    const onAdaptiveAuthRequired = vi.fn()

    render(
      <SearchModeSelector onAdaptiveAuthRequired={onAdaptiveAuthRequired} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Select search mode' }))
    fireEvent.click(screen.getByRole('button', { name: /Balanced/i }))

    expect(onAdaptiveAuthRequired).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(getCookie('searchMode')).toBe('balanced')
    })
  })
})
