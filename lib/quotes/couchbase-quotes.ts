import { type Cluster, connect } from 'couchbase'

// Side-effect imports sort after named ones under the repo's lint config; the
// guard is a build-time marker, so its position in the block does not matter.
// See lib/model-selector/get-model-selector-data.ts for the same placement.
import 'server-only'

import type { Quote } from './types'

// Server-side only. Credentials never reach the browser — the route handler is
// the middle server, the same shape hbqnexus uses.
//
// Unlike hbqnexus this holds ONE connection for the process lifetime rather
// than opening and closing per request; the pool is fetched at most once a day
// and cached in Redis, so a waiting user never triggers a round-trip here.

let clusterPromise: Promise<Cluster> | null = null

// One line per process, not one per request: the quote pool is fetched on a
// cache miss and every miss would otherwise repeat this forever.
let warnedUnconfigured = false

function getCluster(
  url: string,
  username: string,
  password: string
): Promise<Cluster> {
  if (!clusterPromise) {
    clusterPromise = connect(`couchbase://${url}`, {
      username,
      password
    }).catch(error => {
      clusterPromise = null // let the next call retry rather than caching a failure
      throw error
    })
  }
  return clusterPromise
}

/**
 * Read the quotes document. Returns raw rows for `normalizePool` to validate.
 * Never throws: any failure yields an empty array so the caller falls through
 * to its next source.
 */
export async function fetchQuotesFromCouchbase(): Promise<Quote[]> {
  const url = process.env.COUCHBASE_URL
  const username = process.env.COUCHBASE_USERNAME
  const password = process.env.COUCHBASE_PASSWORD
  if (!url || !username || !password) {
    // Without this the feature degrades in total silence: prod serves the
    // couple of dozen bundled quotes instead of the full pool, forever, and
    // nothing anywhere says why. Names only — never a credential value.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true
      const missing = [
        !url && 'COUCHBASE_URL',
        !username && 'COUCHBASE_USERNAME',
        !password && 'COUCHBASE_PASSWORD'
      ].filter(Boolean)
      console.warn(
        `[quotes] Couchbase not configured (missing ${missing.join(', ')}); using the bundled quote set.`
      )
    }
    return []
  }

  const bucketName = process.env.COUCHBASE_QUOTES_BUCKET || 'Quotes'
  const docId = process.env.COUCHBASE_QUOTES_DOC || 'quotes_collection'

  try {
    const cluster = await getCluster(url, username, password)
    const collection = cluster.bucket(bucketName).defaultCollection()
    const result = await collection.get(docId)
    const quotes = (result?.content as { quotes?: unknown })?.quotes
    return Array.isArray(quotes) ? (quotes as Quote[]) : []
  } catch (error) {
    console.warn('[quotes] Couchbase unavailable, falling back:', error)
    return []
  }
}
