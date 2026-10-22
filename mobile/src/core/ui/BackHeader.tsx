// A pushed screen's bar: Back on the left and the screen's title, its h1,
// centred. The side columns are 48 px (not rem), so a larger iOS text size
// leaves the title its room. Used by the Memory and Privacy screens.

const BACK_ICON = 'M15 5l-7 7 7 7'

export function BackHeader({
  title,
  onBack
}: {
  title: string
  onBack: () => void
}) {
  return (
    <header className="grid grid-cols-[48px_minmax(0,1fr)_48px] items-center border-b border-foreground/10 px-1 py-1">
      <button
        type="button"
        aria-label="Back"
        onClick={onBack}
        className="flex size-11 touch-manipulation items-center justify-center rounded-full text-foreground/70 active:opacity-50"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-6"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={BACK_ICON} />
        </svg>
      </button>
      <h1 className="truncate text-center text-base font-semibold">{title}</h1>
    </header>
  )
}
