---
title: Database
---

# Database

Tables, columns, indexes, foreign keys and row-level-security policies, introspected from `lib/db/schema.ts` with Drizzle's `getTableConfig` by `scripts/gen/db-schema.ts` (`bun run gen` in `docs-site/`). Migrations live in `drizzle/` and are applied at container boot.

RLS policies compare the row's owner with `current_setting('app.current_user_id')`, which `withRLS()` sets inside a transaction. They only isolate users when the app connects as the restricted `app_user` role (`DATABASE_RESTRICTED_URL`); the owner connection bypasses them. See [Data layer](/infrastructure/data-layer) for the full model.

<DbSchema />
