import { Component, type ReactNode } from 'react'

import { hideSplash } from '@/app/splash'

type State = { failed: boolean; error: unknown }

/**
 * The app's outermost guard. A render error anywhere below shows a
 * full-screen message with Try again (which renders the app afresh) instead
 * of unmounting everything to a blank page, and hides the native splash so
 * the message is not stuck behind it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, error }
  }

  componentDidCatch(): void {
    hideSplash()
  }

  private retry = () => {
    this.setState({ failed: false, error: null })
  }

  render() {
    if (!this.state.failed) return this.props.children
    const { error } = this.state
    const message = error instanceof Error ? error.message : String(error)
    return (
      // Outside the app root, so it clears the safe area itself (on a
      // wrapper: the message's own padding inside adds to the insets).
      <div className="app-root safe-bottom flex h-dvh flex-col bg-background text-foreground">
        <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p className="text-sm break-words text-foreground/60">{message}</p>
          <button
            type="button"
            onClick={this.retry}
            className="mt-3 h-12 touch-manipulation rounded-xl bg-accent-fill px-8 text-base font-semibold text-white active:opacity-80"
          >
            Try again
          </button>
        </main>
      </div>
    )
  }
}
