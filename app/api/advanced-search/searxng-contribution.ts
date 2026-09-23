// SearXNG's share of an advanced search, resolved from its settled fan-out slot.
//
// SearXNG is ONE provider among several (Tavily, Brave, LangSearch, Ollama web,
// degoog). It used to be treated as the hard dependency of the quality tier: a
// rejected fetch (primary AND fallback down, or neither configured) was
// re-thrown, the route's catch-all returned `{ results: [] }`, and every result
// the other providers had already returned in the same Promise.allSettled was
// thrown away. Now a failure contributes an empty set and the search carries on
// with the rest. Pure and separate from route.ts so it can be unit-tested.

import type { SearXNGResponse } from '@/lib/types'

export type SearxngContribution = {
  data: SearXNGResponse
  /** Base URL the response came from (resolves relative image paths). */
  apiUrl: string
  /** 'ok' | 'skipped' (not fired, e.g. balanced) | 'failed' */
  status: 'ok' | 'skipped' | 'failed'
  /** Why it failed, when it did. */
  error?: unknown
}

export function resolveSearxngContribution(
  settled: PromiseSettledResult<{ data: unknown; baseUrlUsed: string } | null>,
  query: string
): SearxngContribution {
  const empty: SearXNGResponse = { results: [], query, number_of_results: 0 }

  if (settled.status === 'rejected') {
    return { data: empty, apiUrl: '', status: 'failed', error: settled.reason }
  }
  if (!settled.value) {
    return { data: empty, apiUrl: '', status: 'skipped' }
  }

  const data = settled.value.data as SearXNGResponse | null | undefined
  if (!data || !Array.isArray(data.results)) {
    return {
      data: empty,
      apiUrl: '',
      status: 'failed',
      error: new Error('Invalid response structure from SearXNG')
    }
  }
  return { data, apiUrl: settled.value.baseUrlUsed, status: 'ok' }
}
