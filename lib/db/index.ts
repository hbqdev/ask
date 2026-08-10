import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as relations from './relations'
import * as schema from './schema'

// For server-side usage only
// Use restricted user for application if available, otherwise fall back to regular user
const isDevelopment = process.env.NODE_ENV === 'development'
const isTest = process.env.NODE_ENV === 'test'

if (
  !process.env.DATABASE_URL &&
  !process.env.DATABASE_RESTRICTED_URL &&
  !isTest
) {
  throw new Error(
    'DATABASE_URL or DATABASE_RESTRICTED_URL environment variable is not set'
  )
}

// Connection with connection pooling for server environments
// Prefer restricted user for application runtime
const connectionString =
  process.env.DATABASE_RESTRICTED_URL ?? // Prefer restricted user
  process.env.DATABASE_URL ??
  (isTest ? 'postgres://user:pass@localhost:5432/testdb' : undefined)

if (!connectionString) {
  throw new Error(
    'DATABASE_URL or DATABASE_RESTRICTED_URL environment variable is not set'
  )
}

// Log which connection is being used (for debugging)
if (isDevelopment) {
  console.log(
    '[DB] Using connection:',
    process.env.DATABASE_RESTRICTED_URL
      ? 'Restricted User (RLS Active)'
      : 'Owner User (RLS Bypassed)'
  )
}

// SSL configuration: Use environment variable to control SSL
// DATABASE_SSL_DISABLED=true disables SSL completely (for local/Docker PostgreSQL)
// Default is to enable SSL with certificate verification (for cloud databases like Neon, Supabase)
const sslConfig =
  process.env.DATABASE_SSL_DISABLED === 'true'
    ? false // Disable SSL entirely for local PostgreSQL
    : { rejectUnauthorized: true } // Enable SSL with verification for cloud DBs

const client = postgres(connectionString, {
  ssl: sslConfig,
  prepare: false,
  max: 20 // Max 20 connections
})

export const db = drizzle(client, {
  schema: { ...schema, ...relations }
})

// Admin (owner) client, used ONLY for genuine system/cross-user operations that
// have no per-user context and cannot go through withRLS: the file/ingest
// worker (file-actions.ts), the worker's file read (ingest/file/[id]), and the
// cross-user recall backfill. Everything user-facing stays on `db`, which — when
// DATABASE_RESTRICTED_URL points at a non-superuser role — is subject to RLS.
//
// Backwards compatible: with no DATABASE_RESTRICTED_URL set, `db` already uses
// DATABASE_URL, so dbAdmin is the SAME client and behaviour is unchanged from
// before the split. The split only takes effect once the restricted role exists.
const adminConnectionString = process.env.DATABASE_URL ?? connectionString
export const dbAdmin =
  adminConnectionString === connectionString
    ? db
    : drizzle(
        postgres(adminConnectionString, {
          ssl: sslConfig,
          prepare: false,
          max: 5
        }),
        { schema: { ...schema, ...relations } }
      )

// Helper type for all tables
export type Schema = typeof schema

// Fail-fast RLS guard. When auth is on, cross-user isolation depends ENTIRELY on
// the app connecting through a role that cannot bypass row-level security. A
// wrong-worktree / overlay-missing `compose up` can silently put the app on the
// owner URL — the base compose even DEFAULTS DATABASE_RESTRICTED_URL to the owner
// connection — and it boots green with RLS fully off, returning every user's
// private data. So verify the ACTUAL runtime role and REFUSE TO SERVE if it can
// bypass RLS while auth is enabled: a loud crash-loop beats a silent cross-user
// leak. (The previous check was gated NODE_ENV!=='production' AND warn-only, so
// it never ran in prod — exactly where it was needed.)
const authEnabled = process.env.ENABLE_AUTH === 'true'
if (!isTest && typeof window === 'undefined') {
  ;(async () => {
    try {
      const rows = await db.execute<{
        current_user: string
        rolsuper: boolean | null
        rolbypassrls: boolean | null
      }>(
        sql`SELECT current_user,
                   (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
                   (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls`
      )
      const row = rows[0]
      const bypassesRls = Boolean(row?.rolsuper || row?.rolbypassrls)

      if (isDevelopment) {
        console.log(
          '[DB] connected as',
          row?.current_user,
          bypassesRls ? '(RLS BYPASSED)' : '(RLS enforced)'
        )
      }

      if (authEnabled && bypassesRls) {
        console.error(
          `[DB] FATAL: ENABLE_AUTH=true but the app connected as "${row?.current_user}", ` +
            'a role that BYPASSES row-level security — cross-user isolation is OFF. ' +
            'Refusing to serve. Check DATABASE_RESTRICTED_URL and that the deploy used ' +
            'the correct worktree/overlay (RLS enforces only through the non-owner app_user role).'
        )
        // Fail closed: exit so the container restart policy surfaces the misconfig
        // loudly instead of the app quietly serving other users' data.
        process.exit(1)
      }
    } catch (error) {
      // Transient connectivity/permission error on the check itself — log, but do
      // NOT exit, so a momentary DB blip can't crash-loop a correctly-configured app.
      console.error('[DB] RLS guard could not verify the runtime role:', error)
    }
  })()
}
