// Mic gesture heuristic. A single mic button auto-detects tap vs press-and-hold:
// a quick tap (release before the threshold) keeps the existing click-to-toggle
// recording (stopped via the RecordingBar); a press-and-hold (held at or past the
// threshold) is push-to-talk and finalizes on release. Kept pure so the decision
// is unit-testable independent of the DOM.
export const HOLD_THRESHOLD_MS = 250

export function shouldStopOnRelease(heldMs: number): boolean {
  return heldMs >= HOLD_THRESHOLD_MS
}
