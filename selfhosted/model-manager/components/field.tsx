'use client'

import { HelpCircle } from 'lucide-react'

import { EnvVarSpec } from '@/lib/env-schema'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip'

import { ModelListEditor } from './model-list-editor'
import { TestButton } from './test-button'

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
    <div className="grid gap-2 py-3.5 sm:grid-cols-[minmax(0,15rem)_1fr] sm:items-start sm:gap-6">
      {/* Label + help + key */}
      <div className="space-y-1 pt-1.5">
        <div className="flex items-center gap-1.5">
          <Label
            htmlFor={spec.key}
            className="text-sm font-medium leading-none"
          >
            {spec.label}
          </Label>
          {spec.help && (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`About ${spec.label}`}
                    className="text-muted-foreground/60 transition-colors hover:text-foreground"
                  >
                    <HelpCircle className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{spec.help}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <code className="block truncate font-mono text-[11px] text-muted-foreground/80">
          {spec.key}
        </code>
      </div>

      {/* Control */}
      <div className="space-y-1.5">
        {spec.type === 'bool' ? (
          <div className="flex h-9 items-center gap-2.5">
            <Switch
              id={spec.key}
              checked={value === 'true'}
              onCheckedChange={c => onChange(c ? 'true' : 'false')}
            />
            <span className="text-sm text-muted-foreground">
              {value === 'true' ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        ) : spec.type === 'enum' ? (
          <select
            id={spec.key}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={value}
            onChange={e => onChange(e.target.value)}
          >
            <option value="">— none —</option>
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
            className={cn(
              spec.type !== 'secret' && 'font-mono',
              error && 'border-destructive focus-visible:ring-destructive'
            )}
            placeholder={
              spec.type === 'secret' && isSecretSet
                ? '•••••• (unchanged — type to replace)'
                : (spec.default ?? 'not set')
            }
            onChange={e => onChange(e.target.value)}
          />
        )}
        {error && (
          <p className="text-xs font-medium text-destructive">{error}</p>
        )}
        {spec.testable && <TestButton spec={spec} value={value} />}
      </div>
    </div>
  )
}
