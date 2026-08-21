/**
 * Wild Breath — shared physics core.
 *
 * A genuine, chaotic three-body simulation under softened-Newtonian gravity:
 *
 *   aᵢ = Σⱼ≠ᵢ  G·mⱼ(t)·(rⱼ − rᵢ) / (|rⱼ − rᵢ|² + ε²)^{3/2}
 *
 * Each body also *pulses in mass*: mᵢ(t) = m0ᵢ·(1 + AMP·[0.6·sin(f1ᵢt+φ1) +
 * 0.4·sin(f2ᵢt+φ2)]) — two slow, incommensurate tones per body, so the weight
 * wanders unpredictably. Because mass sits inside the force law, a heavier body
 * pulls harder right then (and its rendered size grows with it). Bodies start in
 * the zero-momentum barycentre frame, scaled to a bound state (E < 0) so they
 * stay captured; Plummer softening ε keeps close encounters finite. Since a
 * time-varying mass no longer conserves momentum, `recenter` re-projects into
 * the barycentre frame every step (a pure Galilean shift — the relative dance is
 * untouched), which pins the system on screen.
 *
 * This module is pure math: no DOM access. It is meant to be driven by two
 * independent renderers at once (the SVG logo and the canvas field). The verlet
 * integrator uses module-scoped scratch arrays to stay allocation-free in the
 * hot path; this is re-entrancy-safe for those two consumers because JS is
 * single-threaded and each `advance` call runs fully to completion within one
 * animation frame — the two consumers never interleave a step. `accel` takes its
 * output buffers as parameters so callers own their own state if they need it.
 */

// ── Tuning constants (must match the reference mockup exactly) ──────────────
export const G = 1
export const EPS2 = 0.6
export const MAXDT = 0.003
export const SPEED = 0.6
export const KE_FRAC = 0.16
export const AMP = 0.35
export const FLO = 0.15
export const FHI = 0.4
export const TAU = Math.PI * 2

export type Body = {
  x: number
  y: number
  vx: number
  vy: number
  m: number // current (breathing) mass, fed into the force law
  m0: number // base mass
  f1: number // slow tone 1 frequency
  f2: number // slow tone 2 frequency
  p1: number // tone 1 phase
  p2: number // tone 2 phase
}

export type Bary = {
  cx: number
  cy: number
  mr: number // max distance of any body from the barycentre
}

/**
 * Seed a fresh, bound three-body system in the zero-momentum barycentre frame,
 * energy-scaled so it stays captured (E < 0).
 */
export function boundChaos(): Body[] {
  const b: Body[] = []
  const mass = [
    0.9 + Math.random() * 0.8,
    0.9 + Math.random() * 0.8,
    0.85 + Math.random() * 0.6
  ]
  for (let k = 0; k < 3; k++) {
    const a = Math.random() * TAU
    const r = 0.4 + Math.random() * 0.8
    const va = Math.random() * TAU
    const vs = 0.2 + Math.random() * 0.8
    b.push({
      x: r * Math.cos(a),
      y: r * Math.sin(a),
      vx: Math.cos(va) * vs,
      vy: Math.sin(va) * vs,
      m: mass[k],
      m0: mass[k],
      f1: FLO + Math.random() * (FHI - FLO),
      f2: FLO + Math.random() * (FHI - FLO),
      p1: Math.random() * TAU,
      p2: Math.random() * TAU
    })
  }
  // shift to the zero-momentum barycentre frame
  let M = 0
  let cx = 0
  let cy = 0
  let vx = 0
  let vy = 0
  for (let k = 0; k < 3; k++) {
    M += b[k].m
    cx += b[k].m * b[k].x
    cy += b[k].m * b[k].y
    vx += b[k].m * b[k].vx
    vy += b[k].m * b[k].vy
  }
  cx /= M
  cy /= M
  vx /= M
  vy /= M
  for (let k = 0; k < 3; k++) {
    b[k].x -= cx
    b[k].y -= cy
    b[k].vx -= vx
    b[k].vy -= vy
  }
  // scale kinetic energy to a fixed fraction of |PE| so the system stays bound
  let PE = 0
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const dx = b[j].x - b[i].x
      const dy = b[j].y - b[i].y
      const r = Math.sqrt(dx * dx + dy * dy + EPS2)
      PE -= (G * b[i].m * b[j].m) / r
    }
  }
  let KE = 0
  for (let k = 0; k < 3; k++) {
    KE += 0.5 * b[k].m * (b[k].vx * b[k].vx + b[k].vy * b[k].vy)
  }
  const sc = KE > 1e-6 ? Math.sqrt((KE_FRAC * Math.abs(PE)) / KE) : 1
  for (let k = 0; k < 3; k++) {
    b[k].vx *= sc
    b[k].vy *= sc
  }
  return b
}

/** Pulse every body's mass to sim time `t` (fed straight into the gravity law). */
export function breathe(b: Body[], t: number): void {
  for (let k = 0; k < 3; k++) {
    const o =
      0.6 * Math.sin(b[k].f1 * t + b[k].p1) +
      0.4 * Math.sin(b[k].f2 * t + b[k].p2)
    b[k].m = b[k].m0 * (1 + AMP * o)
    if (b[k].m < 0.25) b[k].m = 0.25
  }
}

/**
 * Re-project into the zero-momentum barycentre frame (undoes the drift a
 * varying mass injects). A pure Galilean shift — the relative dance is untouched.
 */
export function recenter(b: Body[]): void {
  let M = 0
  let cx = 0
  let cy = 0
  let vx = 0
  let vy = 0
  for (let k = 0; k < 3; k++) {
    M += b[k].m
    cx += b[k].m * b[k].x
    cy += b[k].m * b[k].y
    vx += b[k].m * b[k].vx
    vy += b[k].m * b[k].vy
  }
  cx /= M
  cy /= M
  vx /= M
  vy /= M
  for (let k = 0; k < 3; k++) {
    b[k].x -= cx
    b[k].y -= cy
    b[k].vx -= vx
    b[k].vy -= vy
  }
}

// scratch buffers for the verlet integrator (see re-entrancy note above)
const _ax = [0, 0, 0]
const _ay = [0, 0, 0]
const _bx = [0, 0, 0]
const _by = [0, 0, 0]

/**
 * Softened-Newtonian acceleration of every body, written into the caller's
 * `ax`/`ay` buffers.
 */
export function accel(b: Body[], ax: number[], ay: number[]): void {
  ax[0] = ax[1] = ax[2] = ay[0] = ay[1] = ay[2] = 0
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === j) continue
      const dx = b[j].x - b[i].x
      const dy = b[j].y - b[i].y
      const r2 = dx * dx + dy * dy + EPS2
      const inv = 1 / (r2 * Math.sqrt(r2))
      const s = G * b[j].m * inv
      ax[i] += dx * s
      ay[i] += dy * s
    }
  }
}

/** One velocity-Verlet step of size `h`. */
export function verlet(b: Body[], h: number): void {
  accel(b, _ax, _ay)
  for (let i = 0; i < 3; i++) {
    b[i].x += b[i].vx * h + 0.5 * _ax[i] * h * h
    b[i].y += b[i].vy * h + 0.5 * _ay[i] * h * h
  }
  accel(b, _bx, _by)
  for (let i = 0; i < 3; i++) {
    b[i].vx += 0.5 * (_ax[i] + _bx[i]) * h
    b[i].vy += 0.5 * (_ay[i] + _by[i]) * h
  }
}

/** Advance the system by `dt`, sub-stepping so no step exceeds MAXDT. */
export function advance(b: Body[], dt: number): void {
  const n = Math.max(1, Math.ceil(dt / MAXDT))
  const h = dt / n
  for (let s = 0; s < n; s++) verlet(b, h)
}

/** Barycentre and the max radius of any body from it. */
export function bary(b: Body[]): Bary {
  let M = 0
  let cx = 0
  let cy = 0
  for (let k = 0; k < 3; k++) {
    M += b[k].m
    cx += b[k].m * b[k].x
    cy += b[k].m * b[k].y
  }
  cx /= M
  cy /= M
  let mr = 0
  for (let k = 0; k < 3; k++) {
    const d = Math.hypot(b[k].x - cx, b[k].y - cy)
    if (d > mr) mr = d
  }
  return { cx, cy, mr }
}

/**
 * Per-body colour: a shared hue, offset and lightness-nudged per body so the
 * three suns read as a family while cycling the wheel together.
 */
export function colour(i: number, h: number, s: number, l: number): string {
  const off = [0, 35, -40][i]
  const dl = [0, 4, -4][i]
  return `hsl(${(((h + off) % 360) + 360) % 360} ${s}% ${l + dl}%)`
}
