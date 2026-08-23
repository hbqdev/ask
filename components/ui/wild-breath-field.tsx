'use client'

import { useEffect, useRef } from 'react'

import { cn } from '@/lib/utils'
import {
  advance,
  bary,
  boundChaos,
  breathe,
  colour,
  recenter,
  SPEED
} from '@/lib/wild-breath/sim'

import { useTheme } from '@/components/theme-provider'

/**
 * Wild Breath — full-bleed background field.
 *
 * The same chaotic three-body simulation as `WildBreathLogo` (see
 * `lib/wild-breath/sim`), rendered large and glow-forward across a canvas that
 * fills its parent. A fixed camera pins the barycentre near the top third of
 * the frame so the dance sits above a heading. When a body genuinely escapes,
 * the field cross-dissolves to a fresh triple. Decorative only — `aria-hidden`.
 */

const DIM = 0.62 // overall brightness ceiling (dark mode)
const DIM_LIGHT = 0.7 // overall brightness ceiling (light mode)
const TR = 22 // trail length

export function WildBreathField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { resolvedTheme } = useTheme()

  // The rAF draw loop reads this ref each frame, so a theme toggle re-colours
  // the field live without tearing down and restarting the animation. Defaults
  // to 'dark' until the theme provider resolves the active theme on the client.
  const modeRef = useRef<'light' | 'dark'>('dark')
  useEffect(() => {
    modeRef.current = resolvedTheme === 'light' ? 'light' : 'dark'
  }, [resolvedTheme])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let b = boundChaos()
    let hue = Math.random() * 360
    let hist: Array<Array<[number, number]>> = [[], [], []]
    let raf = 0
    let prev = 0
    let running = false

    // cross-dissolve state machine
    let fade = 1
    let phase: 'live' | 'out' | 'in' = 'live'
    let escT = 0 // seconds spent on an escape trajectory
    let T = 0 // sim clock driving the mass pulse

    // cached CSS-pixel dimensions
    let W = 0
    let H = 0

    const size = () => {
      const r = cv.getBoundingClientRect()
      if (!r.width) return
      cv.width = r.width * dpr
      cv.height = r.height * dpr
      W = r.width
      H = r.height
    }

    const frame = (now: number) => {
      if (!running) return
      const DT = Math.min(0.045, (now - prev) / 1000)
      prev = now
      T += DT * SPEED
      breathe(b, T)
      advance(b, DT * SPEED)
      recenter(b)
      hue = (hue + DT * 16) % 360

      // escape watch drives the cross-dissolve — no timer
      const fb = bary(b)
      if (phase === 'live') {
        escT = fb.mr > 4.4 ? escT + DT : 0
        if (escT > 1.3) phase = 'out'
      } else if (phase === 'out') {
        fade -= DT / 0.8
        if (fade <= 0) {
          fade = 0
          b = boundChaos()
          hist = [[], [], []]
          T = 0
          phase = 'in'
        }
      } else {
        fade += DT / 0.8
        if (fade >= 1) {
          fade = 1
          phase = 'live'
          escT = 0
        }
      }

      if (!W) {
        size()
        raf = requestAnimationFrame(frame)
        return
      }

      // fixed camera: barycentre pinned at origin, lifted above the heading
      const light = modeRef.current === 'light'
      const scale = Math.min(W, H) * 0.22
      const a = (light ? DIM_LIGHT : DIM) * fade
      const vc = H * 0.32
      const X = (x: number) => W / 2 + x * scale
      const Y = (y: number) => vc + y * scale

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      // Dark: additive glow on a dark ground. Light: source-over so saturated
      // orbs read on white instead of blowing out to a wash.
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
      for (let k = 0; k < 3; k++) {
        hist[k].unshift([b[k].x, b[k].y])
        if (hist[k].length > TR) hist[k].pop()
        // Light mode uses a more saturated, darker colour so the orb stays
        // visible on a light ground; dark mode keeps the airy glow colour.
        const col = light ? colour(k, hue, 70, 52) : colour(k, hue, 76, 60)
        // size grows steeply with current weight; heavy peaks run large
        const rad = scale * 0.05 * Math.pow(b[k].m, 1.55)
        for (let n = 0; n < hist[k].length; n++) {
          const hh = hist[k][n]
          const t = 1 - n / TR
          // Trails: low-alpha solid colour in both modes; the composite op set
          // above makes them additive (dark) or source-over (light).
          ctx.globalAlpha = t * (light ? 0.09 : 0.11) * a
          ctx.fillStyle = col
          ctx.beginPath()
          ctx.arc(X(hh[0]), Y(hh[1]), Math.max(0.4, rad * t * 1.25), 0, 7)
          ctx.fill()
        }
        const gx = X(b[k].x)
        const gy = Y(b[k].y)
        // Light: a moderate bloom (rad*5) plus a solid-ish core at higher alpha
        // so the orb has clear presence but soft edges. Dark: the big soft
        // bloom (rad*9) at low alpha for an airy glow.
        const bloom = rad * (light ? 5 : 9)
        const grd = ctx.createRadialGradient(gx, gy, 0, gx, gy, bloom)
        grd.addColorStop(0, col)
        grd.addColorStop(1, 'transparent')
        ctx.globalAlpha = (light ? 0.5 : 0.3) * a
        ctx.fillStyle = grd
        ctx.beginPath()
        ctx.arc(gx, gy, bloom, 0, 7)
        ctx.fill()
        ctx.globalAlpha = (light ? 0.9 : 0.62) * a
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.arc(gx, gy, rad * 0.62, 0, 7)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      if (!reduce) raf = requestAnimationFrame(frame)
    }

    running = true
    size()
    prev = performance.now()

    if (reduce) {
      // Static frame: settle a warm-up, then paint once (no rAF loop).
      for (let wm = 0; wm < 200; wm++) {
        T += 0.016 * SPEED
        breathe(b, T)
        advance(b, 0.016)
        recenter(b)
      }
      if (W) frame(prev)
    } else {
      raf = requestAnimationFrame(frame)
    }

    // React-idiomatic resize: covers window resize and parent layout changes.
    const ro = new ResizeObserver(() => {
      const had = W
      size()
      // if reduced-motion couldn't paint before (no size yet), paint now
      if (reduce && W && !had) frame(prev)
    })
    ro.observe(cv)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn('absolute inset-0 h-full w-full', className)}
    />
  )
}

export default WildBreathField
