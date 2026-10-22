import { SplashScreen } from '@capacitor/splash-screen'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from '@/app/ErrorBoundary'
import { resetSplashForTests } from '@/app/splash'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true) }
}))

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn(async () => {}) }
}))

// Throws until the test fixes it.
const failure: { thrown: unknown } = { thrown: null }

function Fragile() {
  if (failure.thrown !== null) throw failure.thrown
  return <p>All good</p>
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSplashForTests()
    failure.thrown = null
    // React reports caught errors on console.error; keep the output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.mocked(console.error).mockRestore()
  })

  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>
    )
    expect(screen.getByText('All good')).toBeInTheDocument()
    expect(SplashScreen.hide).not.toHaveBeenCalled()
  })

  it('shows the error instead of a blank screen, and hides the splash', () => {
    failure.thrown = new Error('render exploded')
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>
    )

    expect(
      screen.getByRole('heading', { name: 'Something went wrong' })
    ).toBeInTheDocument()
    expect(screen.getByText('render exploded')).toBeInTheDocument()
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
    // White on the accent fill: 4.94:1 in both themes.
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveClass(
      'bg-accent-fill',
      'text-white'
    )
    // Outside the app root, so it clears the safe area itself.
    expect(screen.getByRole('main').parentElement).toHaveClass(
      'app-root',
      'safe-bottom'
    )
  })

  it('shows a thrown non-Error too', () => {
    failure.thrown = 'plain failure'
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>
    )
    expect(screen.getByText('plain failure')).toBeInTheDocument()
  })

  it('Try again renders the children again', async () => {
    failure.thrown = new Error('render exploded')
    const user = userEvent.setup()
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>
    )
    expect(screen.queryByText('All good')).not.toBeInTheDocument()

    failure.thrown = null
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('All good')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Something went wrong' })
    ).not.toBeInTheDocument()
  })
})
