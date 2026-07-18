'use client'

import { useMemo, useState } from 'react'
import { CATEGORIES, Category, REGISTRY } from '@/lib/env-schema'
import { Field } from './field'
import { ApplyBar } from './apply-bar'

export interface ConfigData {
  values: Record<string, string>
  secretSet: Record<string, boolean>
  rerankerManaged: boolean
}

export function ConfigForm({ initial }: { initial: ConfigData }) {
  const [active, setActive] = useState<Category>('models')
  const [edits, setEdits] = useState<Record<string, string>>({})

  const value = (key: string) =>
    key in edits ? edits[key] : (initial.values[key] ?? '')

  const changed = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(edits).filter(
          ([k, v]) => v !== (initial.values[k] ?? '')
        )
      ),
    [edits, initial.values]
  )

  const specs = REGISTRY.filter(s => s.category === active)
  const groups = [...new Set(specs.map(s => s.group ?? ''))]

  return (
    <div className="flex min-h-screen">
      <nav className="w-44 shrink-0 space-y-1 border-r p-3">
        {CATEGORIES.map(c => (
          <button
            key={c}
            onClick={() => setActive(c)}
            className={`block w-full rounded-md px-3 py-1.5 text-left text-sm capitalize ${
              active === c ? 'bg-muted font-medium' : 'hover:bg-muted/50'
            }`}
          >
            {c}
          </button>
        ))}
      </nav>

      <main className="max-w-3xl flex-1 p-6 pb-24">
        {groups.map(g => (
          <section key={g} className="mb-6">
            {g && (
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                {g}
              </h2>
            )}
            {specs
              .filter(s => (s.group ?? '') === g)
              .map(s => (
                <Field
                  key={s.key}
                  spec={s}
                  value={value(s.key)}
                  isSecretSet={!!initial.secretSet[s.key]}
                  onChange={v => setEdits(e => ({ ...e, [s.key]: v }))}
                />
              ))}
          </section>
        ))}
      </main>

      <ApplyBar edits={changed} />
    </div>
  )
}
