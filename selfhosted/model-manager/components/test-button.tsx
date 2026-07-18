'use client'

import { useState } from 'react'
import { EnvVarSpec } from '@/lib/env-schema'
import { Button } from '@/components/ui/button'

export function TestButton({
  spec,
  value,
  tokenValue,
  onPick
}: {
  spec: EnvVarSpec
  value: string
  tokenValue?: string
  onPick?: (model: string) => void
}) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [models, setModels] = useState<string[]>([])
  const [error, setError] = useState('')

  async function run() {
    setState('testing')
    setError('')
    setModels([])
    const body =
      spec.testable === 'ollama'
        ? { kind: 'ollama', baseUrl: value }
        : { kind: 'reranker', url: value, token: tokenValue ?? '' }
    try {
      const res = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const r = (await res.json()) as {
        ok: boolean
        models?: string[]
        error?: string
      }
      setState(r.ok ? 'ok' : 'fail')
      if (r.models) setModels(r.models)
      if (r.error) setError(r.error)
    } catch (e) {
      setState('fail')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={run}
        disabled={!value || state === 'testing'}
      >
        {state === 'testing' ? 'Testing…' : 'Test'}
        {state === 'ok' && ' ✓'}
        {state === 'fail' && ' ✗'}
      </Button>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {models.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {models.map(m => (
            <button
              key={m}
              type="button"
              onClick={() => onPick?.(m)}
              className="rounded bg-muted px-2 py-0.5 text-xs hover:bg-muted/70"
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
