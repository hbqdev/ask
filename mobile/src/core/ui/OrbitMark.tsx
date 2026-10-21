// Ask's three-body mark (the web app's app/icon.svg), in the palette's mark
// colours. Decorative: screens name themselves in text.

export function OrbitMark({ className = 'size-16' }: { className?: string }) {
  return (
    <svg
      data-testid="orbit-mark"
      viewBox="20 24 60 54"
      aria-hidden="true"
      className={className}
    >
      <circle cx="39" cy="43" r="17" className="fill-mark-blue" />
      <circle cx="66" cy="39" r="12" className="fill-mark-violet" />
      <circle cx="53" cy="67" r="9" className="fill-mark-orange" />
    </svg>
  )
}
