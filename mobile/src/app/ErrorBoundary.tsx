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
      <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <h1 className="text-xl font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="text-sm break-words text-foreground/60">{message}</p>
        <button
          type="button"
          onClick={this.retry}
          className="mt-3 h-12 touch-manipulation rounded-xl bg-mark-blue px-8 text-base font-semibold text-white active:opacity-80"
        >
          Try again
        </button>
      </main>
    )
  }
}
