'use client'

import { useEffect, useRef } from 'react'

import { cn } from '@/lib/utils'
import {
  advance,
  type Bary,
  bary,
  boundChaos,
  breathe,
  colour,
  recenter,
  SPEED
} from '@/lib/wild-breath/sim'

/**
 * Wild Breath — Ask's signature mark.
 *
 * A genuine, chaotic three-body gravity simulation (see `lib/wild-breath/sim`):
 * three different-mass suns pull on one another under softened-Newtonian
 * gravity, each pulsing its own mass — and therefore its own size and pull —
 * up and down on two slow, incommensurate tones. All three cycle continuously
 * through the colour wheel. A smoothed auto-fit camera keeps the dance framed;
 * only a body genuinely flung to escape reseeds a fresh triple.
 *
 * `WildBreathLogo` runs the live simulation and is meant for large, hero-sized
 * placements. `WildBreathGlyph` is a static three-sun mark (still hue-cycling
 * via CSS) for the small icon slots where a physics sim can't read.
 */

export function WildBreathLogo({
  className,
  ...props
}: React.ComponentProps<'svg'>) {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const c = Array.from(svg.querySelectorAll<SVGCircleElement>('.wb-sun'))
    if (c.length < 3) return

    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let b = boundChaos()
    let hue = Math.random() * 360
    let cam: { cx: number; cy: number; s: number } | null = null

    // Smoothed auto-fit camera + circle paint. Reads the current `b`/`hue`.
    const draw = (fb: Bary) => {
      const fit = 33 / Math.max(0.9, fb.mr + 0.5)
      if (!cam) cam = { cx: fb.cx, cy: fb.cy, s: fit }
      cam.cx += (fb.cx - cam.cx) * 0.05
      cam.cy += (fb.cy - cam.cy) * 0.05
      cam.s += (fit - cam.s) * 0.04
      for (let k = 0; k < 3; k++) {
        c[k].setAttribute('cx', (50 + (b[k].x - cam.cx) * cam.s).toFixed(1))
        c[k].setAttribute('cy', (50 + (b[k].y - cam.cy) * cam.s).toFixed(1))
        c[k].setAttribute(
          'r',
          Math.max(2.2, cam.s * 0.22 * Math.pow(b[k].m, 1.55)).toFixed(1)
        )
        c[k].setAttribute('fill', colour(k, hue, 88, 60))
      }
    }

    if (reduce) {
      // Static frame: settle a warm-up, paint once, no listeners/rAF.
      let T = 0
      for (let w = 0; w < 200; w++) {
        T += 0.016 * SPEED
        breathe(b, T)
        advance(b, 0.016)
        recenter(b)
      }
      draw(bary(b))
      return
    }

    let raf = 0
    let prev = performance.now()
    let escT = 0 // seconds spent on an escape trajectory
    let T = 0 // sim clock driving the mass pulse
    const frame = (now: number) => {
      const DT = Math.min(0.045, (now - prev) / 1000)
      prev = now
      T += DT * SPEED
      breathe(b, T)
      advance(b, DT * SPEED)
      recenter(b)
      hue = (hue + DT * 16) % 360
      // escape watch: only a body genuinely thrown clear reseeds — no timer
      let fb = bary(b)
      escT = fb.mr > 4.4 ? escT + DT : 0
      if (escT > 1.3) {
        b = boundChaos()
        escT = 0
        T = 0
        fb = bary(b)
      }
      draw(fb)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Ask"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-8 overflow-visible', className)}
      {...props}
    >
      <circle className="wb-sun" cx="38" cy="42" r="8" fill="hsl(330 88% 60%)" />
      <circle className="wb-sun" cx="64" cy="40" r="6" fill="hsl(35 88% 64%)" />
      <circle className="wb-sun" cx="52" cy="64" r="5" fill="hsl(290 88% 56%)" />
    </svg>
  )
}

/**
 * Static three-sun mark for small icon slots (sidebar, auth, avatars,
 * spinner, favicon). Cycles hue via CSS so the brand colour still breathes.
 * `spin` adds a slow rotation for busy/loading states.
 */
export function WildBreathGlyph({
  className,
  spin = false,
  ...props
}: React.ComponentProps<'svg'> & { spin?: boolean }) {
  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label="Ask"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('size-8 overflow-visible', className)}
      {...props}
    >
      <g className={cn('wb-glyph origin-center', spin && 'wb-glyph-spin')}>
        <circle className="wb-g1" cx="39" cy="43" r="17" />
        <circle className="wb-g2" cx="66" cy="39" r="12" />
        <circle className="wb-g3" cx="53" cy="67" r="9" />
      </g>
    </svg>
  )
}
