// A control's hit area (.hit-target::after, styles.css) reaches past its box,
// and an ancestor that clips its overflow would cut the reach off. jsdom has
// no layout, so this reads the Tailwind classes that clip.

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
