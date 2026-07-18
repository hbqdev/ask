export async function testOllama(
  baseUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { models?: { name: string }[] }
    return { ok: true, models: (body.models ?? []).map(m => m.name) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function testReranker(
  url: string,
  token: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchFn(`${url.replace(/\/$/, '')}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    })
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
