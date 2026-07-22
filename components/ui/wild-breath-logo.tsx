'use client'

import { useEffect, useRef } from 'react'

import { cn } from '@/lib/utils'

/**
 * Wild Breath — Ask's signature mark.
 *
 * A real three-body gravity simulation: three different-mass suns each drift
 * their own size up and down at random (gravity shifting with them), dancing
 * wide without ever clumping, and tracking the cursor. All three suns cycle
 * continuously through the full colour wheel.
 *
 * `WildBreathLogo` runs the live simulation and is meant for large, hero-sized
 * placements. `WildBreathGlyph` is a static three-sun mark (still hue-cycling
 * via CSS) for the small icon slots where a physics sim can't read.
 */

// Wild Breath tuning — the finalist the design settled on. See the concept
// showcase: Wild's wide, fast orbits fused with Deep Breath's big size swings.
const G = 82
const K = 0.12
const SOFT = 78
const VMAX = 34
const BREATH = 0.9
const TAU = Math.PI * 2
const TRAIL = 24
const SUBSTEPS = 2

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v

type Body = {
  x: number
  y: number
  vx: number
  vy: number
  mc: number // current (eased) mass
  mt: number // target mass
  mtimer: number
}

function seedBodies(): Body[] {
  const b: Body[] = []
  for (let k = 0; k < 3; k++) {
    const a = (k * TAU) / 3 + (Math.random() - 0.5) * 0.6
    const r = 26 + (Math.random() - 0.5) * 6
    const im = 0.5 + Math.random() * 1.6
    b.push({
      x: 50 + r * Math.cos(a),
      y: 50 + r * Math.sin(a),
      vx: -Math.sin(a) * 15 + (Math.random() - 0.5) * 3,
      vy: Math.cos(a) * 15 + (Math.random() - 0.5) * 3,
      mc: im,
      mt: im,
      mtimer: Math.random() * 2.5
    })
  }
  return b
}

// One physics tick. Returns the three suns' positions and radii.
function step(b: Body[], dt: number, cx: number, cy: number, idle: boolean) {
  const mHi = 1.4 + 2.0 * BREATH
  const m: number[] = []
  for (let i = 0; i < 3; i++) {
    b[i].mtimer -= dt
    if (b[i].mtimer <= 0) {
      b[i].mt = 0.4 + Math.random() * (mHi - 0.4)
      b[i].mtimer = 1.3 + Math.random() * 2.6
    }
    b[i].mc += (b[i].mt - b[i].mc) * Math.min(1, dt * 0.6)
    m[i] = Math.max(0.25, b[i].mc)
  }

  for (let st = 0; st < SUBSTEPS; st++) {
    const ax = [0, 0, 0]
    const ay = [0, 0, 0]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === j) continue
        const dx = b[j].x - b[i].x
        const dy = b[j].y - b[i].y
        const dd = Math.hypot(dx, dy) + 0.01
        const d2 = dd * dd + SOFT
        const f = (G * m[j]) / (d2 * dd)
        ax[i] += dx * f
        ay[i] += dy * f
        // soft short-range repulsion so they never collapse together
        if (dd < 23) {
          const rp = ((23 - dd) * 0.5) / dd
          ax[i] -= dx * rp
          ay[i] -= dy * rp
        }
      }
      // anharmonic central well keeps the dance bounded on-screen
      const ex = b[i].x - 50
      const ey = b[i].y - 50
      const kk = K * (1 + (ex * ex + ey * ey) * 0.0016)
      ax[i] -= kk * ex
      ay[i] -= kk * ey
      // gentle cursor pull, layered on top
      if (!idle) {
        ax[i] += 0.13 * (clamp(cx, 16, 84) - b[i].x)
        ay[i] += 0.13 * (clamp(cy, 16, 84) - b[i].y)
      }
    }
    for (let i = 0; i < 3; i++) {
      b[i].vx = (b[i].vx + ax[i] * dt) * 0.9997
      b[i].vy = (b[i].vy + ay[i] * dt) * 0.9997
      const sp = Math.hypot(b[i].vx, b[i].vy)
      if (sp > VMAX) {
        b[i].vx *= VMAX / sp
        b[i].vy *= VMAX / sp
      }
      b[i].x += b[i].vx * dt
      b[i].y += b[i].vy * dt
    }
  }

  const pos: Array<[number, number]> = []
  const rad: number[] = []
  for (let i = 0; i < 3; i++) {
    pos.push([clamp(b[i].x, 4, 96), clamp(b[i].y, 4, 96)])
    rad.push(2 + m[i] * 2.5)
  }
  return { pos, rad }
}

export function WildBreathLogo({
  className,
  ...props
}: React.ComponentProps<'svg'>) {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const suns = Array.from(svg.querySelectorAll<SVGCircleElement>('.wb-sun'))
    const glows = Array.from(svg.querySelectorAll<SVGCircleElement>('.wb-glow'))
    const trailG = svg.querySelector<SVGGElement>('.wb-trails')
    if (suns.length < 3 || !trailG) return

    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const bodies = seedBodies()
    let hue = Math.random() * 360

    const colourFor = (i: number, h: number) => {
      const off = [0, 35, -40][i]
      const light = [58, 62, 55][i]
      return `hsl(${(((h + off) % 360) + 360) % 360} 88% ${light}%)`
    }

    const paint = (pos: Array<[number, number]>, rad: number[], h: number) => {
      for (let i = 0; i < 3; i++) {
        const c = colourFor(i, h)
        suns[i].setAttribute('cx', pos[i][0].toFixed(2))
        suns[i].setAttribute('cy', pos[i][1].toFixed(2))
        suns[i].setAttribute('r', rad[i].toFixed(2))
        suns[i].style.fill = c
        if (glows[i]) {
          glows[i].setAttribute('cx', pos[i][0].toFixed(2))
          glows[i].setAttribute('cy', pos[i][1].toFixed(2))
          glows[i].setAttribute('r', (rad[i] * 2.1).toFixed(2))
          glows[i].style.fill = c
        }
      }
    }

    // Trail dots: TRAIL per sun, tapering in size and opacity.
    const trails: SVGCircleElement[][] = [[], [], []]
    const hist: Array<Array<[number, number, number]>> = [[], [], []]
    for (let k = 0; k < 3; k++) {
      for (let n = 0; n < TRAIL; n++) {
        const dot = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'circle'
        )
        dot.setAttribute('r', '0')
        trailG.appendChild(dot)
        trails[k].push(dot)
      }
    }

    // Cursor influence, smoothed. Coordinates are in the 0..100 viewBox space.
    const L = { tx: 0, ty: 0, vx: 0, vy: 0, last: -1e9 }
    const onMove = (clientX: number, clientY: number) => {
      const rect = svg.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      L.tx = ((clientX - rect.left) / rect.width) * 100 - 50
      L.ty = ((clientY - rect.top) / rect.height) * 100 - 50
      L.last = performance.now()
    }
    const onMouse = (e: MouseEvent) => onMove(e.clientX, e.clientY)
    const onTouch = (e: TouchEvent) => {
      if (e.touches.length) onMove(e.touches[0].clientX, e.touches[0].clientY)
    }

    if (reduce) {
      // Static frame: settle a few ticks, paint once, no listeners/rAF.
      let last = { pos: [], rad: [] } as unknown as ReturnType<typeof step>
      for (let i = 0; i < 40; i++) last = step(bodies, 0.03, 0, 0, true)
      paint(last.pos, last.rad, hue)
      return
    }

    window.addEventListener('mousemove', onMouse)
    window.addEventListener('touchmove', onTouch, { passive: true })

    let raf = 0
    let prev = performance.now()
    const tick = (now: number) => {
      const DT = Math.min(0.045, (now - prev) / 1000)
      prev = now
      const dt = DT * 1.3

      // ease cursor influence in/out
      L.vx += (L.tx - L.vx) * 0.12
      L.vy += (L.ty - L.vy) * 0.12
      const idle = now - L.last > 2600

      const { pos, rad } = step(bodies, dt, 50 + L.vx, 50 + L.vy, idle)

      hue = (hue + DT * 20) % 360
      paint(pos, rad, hue)

      for (let k = 0; k < 3; k++) {
        hist[k].unshift([pos[k][0], pos[k][1], rad[k]])
        if (hist[k].length > TRAIL) hist[k].pop()
        const col = colourFor(k, hue)
        for (let n = 0; n < TRAIL; n++) {
          const dot = trails[k][n]
          const h = hist[k][n]
          if (!h) {
            dot.setAttribute('r', '0')
            continue
          }
          const t = 1 - n / TRAIL
          dot.setAttribute('cx', h[0].toFixed(2))
          dot.setAttribute('cy', h[1].toFixed(2))
          dot.setAttribute('r', (h[2] * t * 0.7).toFixed(2))
          dot.style.fill = col
          dot.style.opacity = (t * 0.45).toFixed(3)
        }
      }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMouse)
      window.removeEventListener('touchmove', onTouch)
    }
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
      <defs>
        <filter id="wb-soft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      <g className="wb-trails" filter="url(#wb-soft)" />
      <g filter="url(#wb-soft)" opacity="0.55">
        <circle className="wb-glow" cx="50" cy="50" r="6" />
        <circle className="wb-glow" cx="50" cy="50" r="6" />
        <circle className="wb-glow" cx="50" cy="50" r="6" />
      </g>
      <g>
        <circle className="wb-sun" cx="38" cy="42" r="8" />
        <circle className="wb-sun" cx="64" cy="40" r="6" />
        <circle className="wb-sun" cx="52" cy="64" r="5" />
      </g>
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
