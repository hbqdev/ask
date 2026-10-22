// The app's shared class names, so one kind of control looks one way
// everywhere. A segmented control (one exclusive choice: the search mode, the
// speed, the theme, the Library's sections) raises the chosen segment as a
// thumb on a muted track. A chip (a topic, a source) inverts when it is on.

/**
 * A readable column: a screen's content, centred and at most 720 px wide, so
 * lines stay short on an iPad. It goes on the content inside a scroller; the
 * scroller, its pull area, a header's hairline and the tab bar stay full
 * width.
 */
export const READABLE = 'mx-auto w-full max-w-[720px]'

/** A group: a rounded card of rows or controls. */
export const GROUP = 'rounded-2xl bg-card'

/** A section's title, over its group. */
export const SECTION_TITLE =
  'px-4 pb-2 text-xs font-medium uppercase tracking-wide text-foreground/60'

/**
 * A list row's inset hairline along its bottom, from its text to the edge.
 * Drawn on the row's positioned content, so it moves with a swipe; every row
 * but the last of its group has one.
 */
export const SEPARATOR =
  'after:absolute after:bottom-0 after:left-4 after:right-0 after:h-px after:bg-border'

/** The track a segmented control's segments sit in. */
export const SEGMENT_TRACK = 'flex gap-1 rounded-xl bg-muted p-1'

/** A segment of a segmented control: the chosen one is the raised thumb. */
export function segmentClass(selected: boolean): string {
  return selected
    ? 'bg-thumb text-foreground shadow-sm dark:shadow-none'
    : 'text-muted-foreground active:opacity-50'
}

/** A chip: inverted when on, muted when off. */
export function chipClass(on: boolean): string {
  return on ? 'bg-foreground text-background' : 'bg-muted text-foreground'
}
