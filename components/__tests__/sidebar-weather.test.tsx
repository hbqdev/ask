import React from 'react'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

vi.mock('@/hooks/use-client-setting', () => ({
  useClientSettingValue: () => 'metric'
}))

vi.mock('@/hooks/use-weather', () => ({
  useWeather: () => ({
    weather: {
      city: 'San Francisco',
      code: 0,
      isDay: true,
      temp: 17,
      feelsLike: 17,
      humidity: 81,
      windSpeed: 12,
      sunrise: '2026-09-22T13:57:00Z',
      sunset: '2026-09-23T02:06:00Z',
      forecast: [
        { date: '2026-09-23', code: 0, tempMax: 28, tempMin: 11 },
        { date: '2026-09-24', code: 3, tempMax: 22, tempMin: 14 }
      ]
    },
    loading: false,
    isManual: false,
    setManualLocation: vi.fn(),
    clearManualLocation: vi.fn()
  })
}))

import { SidebarWeather } from '../sidebar-weather'

describe('SidebarWeather', () => {
  test('desktop (default) renders the full card with details + forecast', () => {
    const { container } = render(<SidebarWeather />)
    expect(container.querySelector('[data-weather-card="full"]')).not.toBeNull()
    expect(screen.getByTitle('Humidity')).toBeTruthy()
    expect(screen.queryByLabelText(/show weather details/i)).toBeNull()
  })

  test('compact starts as a one-line summary and expands/collapses on tap', () => {
    const { container } = render(<SidebarWeather compact />)
    const summary = screen.getByRole('button', {
      name: /show weather details/i
    })
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(summary.textContent).toContain('San Francisco')
    expect(summary.textContent).toContain('17°C')
    // Details + forecast are not rendered while collapsed.
    expect(screen.queryByTitle('Humidity')).toBeNull()

    fireEvent.click(summary)
    expect(
      container.querySelector('[data-weather-card="expanded"]')
    ).not.toBeNull()
    expect(screen.getByTitle('Humidity')).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', { name: /hide weather details/i })
    )
    expect(
      container.querySelector('[data-weather-card="compact"]')
    ).not.toBeNull()
  })
})
