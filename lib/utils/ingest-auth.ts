import crypto from 'node:crypto'

// Fail-closed bearer gate for the ingestion worker API. Mirrors the
// reranker service's auth: unset token means the feature is OFF (503),
// and comparison is constant-time.
export function checkIngestAuth(
  authorization: string | null
): { ok: true } | { ok: false; status: 503 | 401 } {
  const token = process.env.INGEST_API_TOKEN
  if (!token) return { ok: false, status: 503 }
  const expected = Buffer.from(`Bearer ${token}`)
  const got = Buffer.from(authorization ?? '')
  if (
    got.length !== expected.length ||
    !crypto.timingSafeEqual(got, expected)
  ) {
    return { ok: false, status: 401 }
  }
  return { ok: true }
}
