// A small named-stage timer for pipelines that span one function.
//
// LatencyTracker covers the per-turn chat line (ttft, skipSearch). This is the
// generic sibling: wrap a stage in `time()` and it records the duration whether
// the stage succeeds or throws, so a slow-and-failing stage is still visible in
// the numbers. Emits one tagged line, mirrored to the durable sink.

import { durableLatencySink } from './latency-store'

type Meta = Record<string, unknown>

export class StageTimer {
  private readonly startedAt: number
  private readonly fields: Record<string, unknown> = {}

  constructor(
    private readonly tag: string,
    private readonly meta: Meta = {},
    private readonly now: () => number = () => performance.now(),
    private readonly sink: (line: string) => void = durableLatencySink
  ) {
    this.startedAt = this.now()
  }

  /** Run `fn`, recording how long it took under `name` even if it throws. */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = this.now()
    try {
      return await fn()
    } finally {
      this.fields[name] = Math.round(this.now() - started)
    }
  }

  /** Record a pre-measured duration (ms). */
  mark(name: string, ms: number): void {
    this.fields[name] = Math.round(ms)
  }

  /** Record a non-timing value — pool sizes, counts, which path was taken. */
  set(name: string, value: unknown): void {
    this.fields[name] = value
  }

  /**
   * Snapshot of the recorded DURATION fields (keys ending in `_ms`), so a
   * caller can fold these stage timings into another line — e.g. the per-turn
   * [latency] line accumulating a search's crawl/enrich/rerank cost. Counts
   * and path markers set via `set()` are excluded. Never throws.
   */
  timings(): Record<string, number> {
    const out: Record<string, number> = {}
    try {
      for (const [k, v] of Object.entries(this.fields)) {
        if (k.endsWith('_ms') && typeof v === 'number') out[k] = v
      }
    } catch {
      // Telemetry must never break the pipeline it measures.
    }
    return out
  }

  /** Emit the single tagged line. */
  emit(extra: Meta = {}): void {
    try {
      this.sink(
        `[${this.tag}] ${JSON.stringify({
          ...this.meta,
          ...this.fields,
          ...extra,
          total_ms: Math.round(this.now() - this.startedAt)
        })}`
      )
    } catch {
      // Telemetry must never break the pipeline it measures.
    }
  }
}
