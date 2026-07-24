// One structured latency line per chat turn. Additive telemetry only — it
// never touches answer content. Emitted by default (one line/turn is cheap
// and the point is to see numbers in prod), unlike the opt-in perfLog helpers.

type Meta = { chatId?: string | null; mode: string }

export class LatencyTracker {
  private readonly startedAt: number
  private readonly marks: Record<string, number> = {}
  private firstTokenAt: number | null = null

  constructor(
    private readonly meta: Meta,
    private readonly now: () => number = () => performance.now(),
    private readonly sink: (line: string) => void = line => console.log(line)
  ) {
    this.startedAt = this.now()
  }

  /** Record a completed stage duration (ms). */
  mark(name: string, ms: number): void {
    this.marks[name] = Math.round(ms)
  }

  /** Stamp the moment the first output chunk reached the client. Idempotent. */
  markFirstToken(): void {
    if (this.firstTokenAt === null) this.firstTokenAt = this.now()
  }

  /** Emit the single per-turn line. */
  emit(extra: { skipSearch?: boolean | null }): void {
    try {
      const total = Math.round(this.now() - this.startedAt)
      const ttft =
        this.firstTokenAt === null
          ? null
          : Math.round(this.firstTokenAt - this.startedAt)
      this.sink(
        `[latency] ${JSON.stringify({
          chatId: this.meta.chatId ?? null,
          mode: this.meta.mode,
          ...this.marks,
          ttft_ms: ttft,
          total_ms: total,
          skipSearch: extra.skipSearch ?? null
        })}`
      )
    } catch {
      // Telemetry must never break a turn.
    }
  }
}
