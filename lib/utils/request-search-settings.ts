import { SearchMode, SearchSources, SourceMode } from '@/lib/types/search'

const SEARCH_MODES: readonly SearchMode[] = ['speed', 'balanced', 'quality']
const SOURCE_MODES: readonly SourceMode[] = ['web', 'academic', 'social']

function isSearchMode(value: unknown): value is SearchMode {
  return typeof value === 'string' && SEARCH_MODES.includes(value as SearchMode)
}

/** A non-empty array of known sources, deduplicated; otherwise null. */
function parseBodySources(value: unknown): SearchSources | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (
    !value.every(
      v => typeof v === 'string' && SOURCE_MODES.includes(v as SourceMode)
    )
  ) {
    return null
  }
  return Array.from(new Set(value as SourceMode[]))
}

function searchModeFromCookie(cookie: string | undefined): SearchMode {
  // Backward compat: map old values to new ones
  const normalized =
    cookie === 'quick' ? 'speed' : cookie === 'adaptive' ? 'balanced' : cookie
  return isSearchMode(normalized) ? normalized : 'balanced'
}

function sourcesFromCookie(cookie: string | undefined): SearchSources {
  if (cookie) {
    try {
      const parsed = JSON.parse(cookie)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as SearchSources
      }
    } catch {
      // ignore parse errors, fall back to default
    }
  }
  return ['web']
}

/**
 * Resolve the search mode and sources for a chat request.
 *
 * Valid body values win (the bundled mobile app sends them with a bearer
 * token and no cookies). Missing or invalid body values fall back to the
 * cookie rules the web app has always used.
 */
export function resolveSearchSettings(input: {
  bodySearchMode?: unknown
  bodySources?: unknown
  cookieSearchMode?: string
  cookieSources?: string
}): { searchMode: SearchMode; sources: SearchSources } {
  return {
    searchMode: isSearchMode(input.bodySearchMode)
      ? input.bodySearchMode
      : searchModeFromCookie(input.cookieSearchMode),
    sources:
      parseBodySources(input.bodySources) ??
      sourcesFromCookie(input.cookieSources)
  }
}
