// The app shell. Later tasks mount the tab bar and screens inside this root.
export default function App() {
  return (
    <div
      data-testid="app-root"
      className="flex min-h-dvh flex-col bg-background text-foreground"
    >
      <main className="flex flex-1 items-center justify-center">
        <h1 className="text-2xl font-semibold tracking-tight">Ask</h1>
      </main>
    </div>
  )
}
