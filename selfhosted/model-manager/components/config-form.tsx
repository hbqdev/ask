'use client'

import {
  Brain,
  Cpu,
  Database,
  HardDrive,
  LogOut,
  Search,
  Server,
  ShieldCheck
} from 'lucide-react'
import { type ComponentType, useMemo, useState } from 'react'

import { CATEGORIES, CATEGORY_META, Category, REGISTRY } from '@/lib/env-schema'
import { cn } from '@/lib/utils'

import { ApplyBar } from './apply-bar'
import { Field } from './field'

export interface ConfigData {
  values: Record<string, string>
  secretSet: Record<string, boolean>
  rerankerManaged: boolean
}

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Cpu,
  Search,
  Database,
  ShieldCheck,
  Brain,
  HardDrive,
  Server
}

async function signOut() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  window.location.href = '/login'
}

export function ConfigForm({ initial }: { initial: ConfigData }) {
  // Only show categories that actually have manageable vars.
  const cats = CATEGORIES.filter(c => REGISTRY.some(s => s.category === c))
  const [active, setActive] = useState<Category>(cats[0] ?? 'models')
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
  const meta = CATEGORY_META[active]
  const ActiveIcon = ICONS[meta.icon] ?? Server

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Cpu className="size-4" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">Ask · Model Manager</div>
              <div className="text-[11px] text-muted-foreground">
                Edit the stack&apos;s config, apply with one click
              </div>
            </div>
          </div>
          <button
            onClick={signOut}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <LogOut className="size-3.5" />
            Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-6 px-4 py-6 sm:px-6">
        {/* Sidebar (desktop) */}
        <nav className="hidden w-56 shrink-0 space-y-1 sm:block">
          {cats.map(c => {
            const m = CATEGORY_META[c]
            const Icon = ICONS[m.icon] ?? Server
            const on = active === c
            return (
              <button
                key={c}
                onClick={() => setActive(c)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                  on
                    ? 'bg-background shadow-sm ring-1 ring-border'
                    : 'hover:bg-background/60'
                )}
              >
                <Icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    on ? 'text-foreground' : 'text-muted-foreground'
                  )}
                />
                <span className="min-w-0">
                  <span
                    className={cn(
                      'block text-sm font-medium',
                      on ? 'text-foreground' : 'text-foreground/80'
                    )}
                  >
                    {m.label}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                    {m.description}
                  </span>
                </span>
              </button>
            )
          })}
        </nav>

        {/* Content */}
        <main className="min-w-0 flex-1 space-y-5 pb-28">
          {/* Mobile category picker */}
          <select
            value={active}
            onChange={e => setActive(e.target.value as Category)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:hidden"
          >
            {cats.map(c => (
              <option key={c} value={c}>
                {CATEGORY_META[c].label}
              </option>
            ))}
          </select>

          {/* Category header */}
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg border bg-background">
              <ActiveIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-none">
                {meta.label}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {meta.description}
              </p>
            </div>
          </div>

          {/* Grouped cards */}
          {groups.map(g => (
            <div
              key={g}
              className="overflow-hidden rounded-xl border bg-card shadow-sm"
            >
              {g && (
                <div className="border-b bg-muted/40 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {g}
                </div>
              )}
              <div className="divide-y px-4">
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
              </div>
            </div>
          ))}
        </main>
      </div>

      <ApplyBar edits={changed} />
    </div>
  )
}
