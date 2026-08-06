// One structured latency line per chat turn. Additive telemetry only — it
// never touches answer content. Emitted by default (one line/turn is cheap
// and the point is to see numbers in prod), unlike the opt-in perfLog helpers.

// modelId is load-bearing, not decoration: generation is the largest slice of
// a research turn, and without it in the line there is no way to attribute
// that time to a model. Inferring it from the UI's model selector is wrong —
// the selector shows the CURRENT choice, not what the turn actually ran on.
type Meta = { chatId?: string | null; mode: string; modelId?: string | null }

/**
 * Silence before an abort, above which the turn looks like a PROVIDER stall
 * rather than a user pressing stop.
 *
 * Sits between the two populations actually measured: client disconnects at
 * 8.1s and 36.5s, and the single observed provider stall at 302s. 120s is
 * comfortably above every real disconnect seen and far below the stall, and
 * it is only used to decide whether to log loudly — abort_silence_ms is
 * always emitted, so a wrong threshold costs nothing but a missing warning.
 */
const STALL_SUSPECT_SILENCE_MS = 120_000

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
  // Citation anchors this turn emitted, split by whether they name a tool call
  // this same turn made. Both failure modes are silent at render time —
  // processCitations returns '' for an id it cannot resolve and renders the
  // wrong source for one belonging to another turn — so without a counter here
  // there is no signal at all that citations are failing.
  private citations: { total: number; unresolved: number } | null = null

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

  /**
   * Record this turn's citation audit. Absent or empty audits are not emitted,
   * so turns that cited nothing stay out of the denominator.
   */
  markCitations(audit: { total: number; unresolved: number }): void {
    this.citations = audit
  }

  /** Emit the single per-turn line. */
  emit(extra: {
    skipSearch?: boolean | null
    needsRecent?: boolean | null
    needsSources?: boolean | null
  }): void {
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
      // ABORT FORENSICS. A turn that ends in `abort` is either a user pressing
      // stop or a provider that went silent, and the existing marks cannot tell
      // them apart without reconstructing the gap by hand every time.
      //
      // Measured on 208 prod+staging turns: the two aborts were client
      // disconnects, 36.5s and 8.1s of silence, both far short of the 300s
      // ceiling. The one genuine provider stall ever seen (lab, a different
      // architecture) was 302s of silence before the ceiling fired, with no
      // prose. So the discriminator is the SILENCE, not the abort.
      //
      // Emitted as a raw number rather than a verdict: the threshold below is
      // a convenience for spotting it in logs, and a number in the line is what
      // survives a threshold turning out to be wrong.
      const abortAt = this.streamParts['abort']
      let abortSilenceMs: number | null = null
      if (typeof abortAt === 'number') {
        const others = Object.entries(this.streamParts)
          .filter(([k]) => k !== 'abort')
          .map(([, v]) => v)
        abortSilenceMs = others.length
          ? Math.round(abortAt - Math.max(...others))
          : Math.round(abortAt)
      }
      const blankAbort =
        typeof abortAt === 'number' && typeof textAt !== 'number'
      if (
        blankAbort &&
        abortSilenceMs !== null &&
        abortSilenceMs >= STALL_SUSPECT_SILENCE_MS
      ) {
        // Loud on purpose. This is the signature the stall-recovery work on
        // flow-design-pipeline exists to fix, and it has never been observed
        // here — if it starts appearing, that fix becomes worth porting.
        console.warn(
          `[stall-suspect] chat=${this.meta.chatId ?? '?'} silent ${Math.round(abortSilenceMs / 1000)}s before abort with no prose — provider stall, not a client disconnect`
        )
      }

      this.sink(
        `[latency] ${JSON.stringify({
          chatId: this.meta.chatId ?? null,
          mode: this.meta.mode,
          // Which control-flow variant produced this turn. Without it a
          // results file cannot be attributed to an arm after the fact, and
          // arms are switched by restarting the container.
          variant: process.env.FLOW_VARIANT || 'baseline',
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
          ...(this.citations !== null &&
            this.citations.total > 0 && {
              citations_total: this.citations.total,
              citations_unresolved: this.citations.unresolved
            }),
          total_ms: total,
          // Present only on aborted turns. blank_abort distinguishes "the user
          // stopped it mid-answer" from "nothing was ever written".
          ...(abortSilenceMs !== null && {
            abort_silence_ms: abortSilenceMs,
            blank_abort: blankAbort
          }),
          // All three, because together they determine which prompt/tool mode
          // the turn got (resolveTurnMode in lib/agents/researcher.ts).
          // skipSearch alone cannot tell "answered from knowledge on purpose"
          // apart from "searched and found nothing".
          skipSearch: extra.skipSearch ?? null,
          needsRecent: extra.needsRecent ?? null,
          needsSources: extra.needsSources ?? null
        })}`
      )
    } catch {
      // Telemetry must never break a turn.
    }
  }
}
