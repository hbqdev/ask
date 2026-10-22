// A control's hit area (.hit-target::after, styles.css) reaches past its box,
// and an ancestor that clips its overflow would cut the reach off. jsdom has
// no layout, so this reads the Tailwind classes that clip.
//
// What it cannot see (checked by hand when this was written; the device
// pass's elementFromPoint sweep is the backstop):
// - clips declared in styles.css (.stack-view { overflow: hidden } sits above
//   every screen root; .katex-display is never an ancestor of a control);
// - an inline style.overflow;
// - variant classes (md:overflow-hidden, which clips at those widths only);
// - paint containment (contain: paint, content-visibility: auto: a past
//   answer, padded for the areas at its edge, features/thread/model/layout.ts).

const CLIPS = /^overflow(?:-[xy])?-(?:hidden|clip)$/

/**
 * The class lists of `el`'s ancestors, nearest first, up to and including
 * `root`, that clip their overflow (overflow, overflow-x or overflow-y hidden
 * or clip). Scrollers (auto, scroll) are not counted.
 */
export function clippingAncestors(el: Element, root: Element): string[] {
  const found: string[] = []
  for (let node = el.parentElement; node; node = node.parentElement) {
    if ([...node.classList].some(c => CLIPS.test(c))) found.push(node.className)
    if (node === root) break
  }
  return found
}
