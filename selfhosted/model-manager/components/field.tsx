'use client'

import { EnvVarSpec } from '@/lib/env-schema'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ModelListEditor } from './model-list-editor'

export function Field({
  spec,
  value,
  onChange,
  isSecretSet
}: {
  spec: EnvVarSpec
  value: string
  onChange: (v: string) => void
  isSecretSet: boolean
}) {
  const error = spec.validate && value.trim() ? spec.validate(value) : null

  return (
    <div className="space-y-1.5 py-2">
      <Label htmlFor={spec.key} className="text-sm font-medium">
        {spec.label}{' '}
        <span className="text-xs font-normal text-muted-foreground">
          {spec.key}
        </span>
      </Label>

      {spec.type === 'bool' ? (
        <Switch
          checked={value === 'true'}
          onCheckedChange={c => onChange(c ? 'true' : 'false')}
        />
      ) : spec.type === 'enum' ? (
        <select
          id={spec.key}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={value}
          onChange={e => onChange(e.target.value)}
        >
          <option value="">—</option>
          {spec.enumValues!.map(o => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : spec.type === 'model-list' ? (
        <ModelListEditor value={value} onChange={onChange} />
      ) : (
        <Input
          id={spec.key}
          type={spec.type === 'secret' ? 'password' : 'text'}
          value={value}
          placeholder={
            spec.type === 'secret' && isSecretSet
              ? '•••••• (unchanged — type to replace)'
              : spec.default
          }
          onChange={e => onChange(e.target.value)}
        />
      )}

      {spec.help && (
        <p className="text-xs text-muted-foreground">{spec.help}</p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}
