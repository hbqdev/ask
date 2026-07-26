// One structured latency line per chat turn. Additive telemetry only — it
// never touches answer content. Emitted by default (one line/turn is cheap
// and the point is to see numbers in prod), unlike the opt-in perfLog helpers.

// modelId is load-bearing, not decoration: generation is the largest slice of
// a research turn, and without it in the line there is no way to attribute
// that time to a model. Inferring it from the UI's model selector is wrong —
// the selector shows the CURRENT choice, not what the turn actually ran on.
type Meta = { chatId?: string | null; mode: string; modelId?: string | null }

export class LatencyTracker {
  private readonly startedAt: number
  private readonly marks: Record<string, number> = {}
  private firstTokenAt: number | null = null
  // First-seen offset per UI-message part type. ttft_ms only sees the first
  // chunk of ANY kind — a tool call on a research turn — so on its own it
  // cannot show when prose actually started. Measured on staging: first chunk
  // 13.5s, first sentence ~88s.
  private readonly streamParts: Record<string, number> = {}
  // A research turn is multi-step and both original metrics were confounded
  // by that. Counts make the step structure visible; lastSeen lets ingestion
  // be measured from the LAST tool output, so a turn that adds a fetch step
  // is not misread as slower prompt processing.
  private readonly partCounts: Record<string, number> = {}
  private readonly partLastSeen: Record<string, number> = {}
  private usage: { inputTokens?: number; outputTokens?: number } | null = null
  private lastStepInputTokens: number | null = null

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

  /**
   * Stamp the first time a UI-message part of this type reached the client.
   * Repeats are ignored, so the emitted map is a timeline of firsts.
   */
  markStreamPart(type: string): void {
    const at = Math.round(this.now() - this.startedAt)
    if (this.streamParts[type] === undefined) this.streamParts[type] = at
    this.partCounts[type] = (this.partCounts[type] ?? 0) + 1
    this.partLastSeen[type] = at
  }

  /**
   * Record token usage for the turn. Absent counts are simply not emitted.
   *
   * `usage` is the SUM across steps (the AI SDK's totalUsage), so on its own
   * it cannot answer "how big was the prompt" on a multi-step turn.
   * `lastStepInputTokens` is the final step's input — the actual answering
   * prompt, and the number to judge a prompt-size change by.
   */
  markUsage(
    usage: { inputTokens?: number; outputTokens?: number },
    lastStepInputTokens?: number
  ): void {
    this.usage = usage
    this.lastStepInputTokens =
      typeof lastStepInputTokens === 'number' ? lastStepInputTokens : null
  }

  /** Emit the single per-turn line. */
  emit(extra: { skipSearch?: boolean | null }): void {
    try {
      const total = Math.round(this.now() - this.startedAt)
      const ttft =
        this.firstTokenAt === null
          ? null
          : Math.round(this.firstTokenAt - this.startedAt)
      const streamSeen = Object.keys(this.streamParts).length > 0
      // Ingestion = last tool result → first prose. After the last tool
      // output there is nothing left but the model reading and generating,
      // so this isolates prompt processing from tool round trips.
      const lastToolAt = this.partLastSeen['tool-output-available']
      const textAt = this.streamParts['text-start']
      const ingest =
        typeof lastToolAt === 'number' &&
        typeof textAt === 'number' &&
        textAt >= lastToolAt
          ? textAt - lastToolAt
          : null
      this.sink(
        `[latency] ${JSON.stringify({
          chatId: this.meta.chatId ?? null,
          mode: this.meta.mode,
          modelId: this.meta.modelId ?? null,
          ...this.marks,
          ttft_ms: ttft,
          steps: this.partCounts['start-step'] ?? 0,
          tool_calls: this.partCounts['tool-input-available'] ?? 0,
          ...(ingest !== null && { ingest_ms: ingest }),
          ...(streamSeen && { stream: this.streamParts }),
          ...(typeof this.usage?.inputTokens === 'number' && {
            prompt_tokens: this.usage.inputTokens
          }),
          ...(this.lastStepInputTokens !== null && {
            last_prompt_tokens: this.lastStepInputTokens
          }),
          ...(typeof this.usage?.outputTokens === 'number' && {
            completion_tokens: this.usage.outputTokens
          }),
          total_ms: total,
          skipSearch: extra.skipSearch ?? null
        })}`
      )
    } catch {
      // Telemetry must never break a turn.
    }
  }
}
