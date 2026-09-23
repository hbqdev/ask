// db-schema.json — tables, columns, indexes, FKs and RLS policies from
// lib/db/schema.ts, introspected with drizzle's getTableConfig.
import { is, SQL } from 'drizzle-orm'
import { PgDialect, getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { readdirSync } from 'node:fs'
import path from 'node:path'

import { REPO } from './lib'

const dialect = new PgDialect()

function sqlText(v: unknown): string | null {
  if (v == null) return null
  if (is(v, SQL)) {
    try {
      return dialect.sqlToQuery(v as SQL).sql
    } catch {
      return '(sql)'
    }
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function colName(c: any): string {
  return c?.name ?? (is(c, SQL) ? sqlText(c) : String(c))
}

export async function generateDbSchema() {
  const schemaFile = 'lib/db/schema.ts'
  const mod = await import(path.join(REPO, schemaFile))
  const tables: any[] = []
  for (const [exportName, value] of Object.entries(mod)) {
    if (!is(value, PgTable)) continue
    const cfg = getTableConfig(value as PgTable)
    tables.push({
      name: cfg.name,
      exportName,
      schema: cfg.schema ?? 'public',
      rlsEnabled: Boolean((cfg as any).enableRLS) || cfg.policies.length > 0,
      columns: cfg.columns.map((c: any) => ({
        name: c.name,
        type: c.getSQLType(),
        notNull: Boolean(c.notNull),
        primaryKey: Boolean(c.primary),
        unique: Boolean(c.isUnique),
        default: c.default !== undefined
          ? sqlText(c.default)
          : c.defaultFn
            ? '(generated in app)'
            : null,
        enumValues: c.enumValues ?? null
      })),
      indexes: cfg.indexes.map((i: any) => ({
        name: i.config.name ?? null,
        columns: i.config.columns.map(colName),
        unique: Boolean(i.config.unique),
        method: i.config.method ?? 'btree',
        where: sqlText(i.config.where)
      })),
      foreignKeys: cfg.foreignKeys.map((fk: any) => {
        const r = fk.reference()
        return {
          name: fk.getName(),
          columns: r.columns.map((c: any) => c.name),
          foreignTable: getTableConfig(r.foreignTable).name,
          foreignColumns: r.foreignColumns.map((c: any) => c.name),
          onDelete: fk.onDelete ?? null,
          onUpdate: fk.onUpdate ?? null
        }
      }),
      checks: cfg.checks.map((c: any) => ({ name: c.name, value: sqlText(c.value) })),
      primaryKeys: cfg.primaryKeys.map((p: any) => ({
        name: p.getName(),
        columns: p.columns.map((c: any) => c.name)
      })),
      policies: cfg.policies.map((p: any) => ({
        name: p.name,
        as: p.as ?? 'permissive',
        for: p.for ?? 'all',
        to: Array.isArray(p.to) ? p.to.map(String) : p.to ? [String(p.to)] : ['public'],
        using: sqlText(p.using),
        withCheck: sqlText(p.withCheck)
      }))
    })
  }
  tables.sort((a, b) => a.name.localeCompare(b.name))
  let migrations: string[] = []
  try {
    migrations = readdirSync(path.join(REPO, 'drizzle')).filter(f => f.endsWith('.sql')).sort()
  } catch {}
  return {
    source: schemaFile,
    migrationsDir: 'drizzle/',
    migrations,
    count: tables.length,
    tables
  }
}
