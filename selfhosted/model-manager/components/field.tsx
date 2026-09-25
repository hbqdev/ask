'use client'

import { HelpCircle } from 'lucide-react'

import { boolIsOn, boolLiteral, EnvVarSpec } from '@/lib/env-schema'
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
  isSecretSet,
  cleared = false,
  onClear
}: {
  spec: EnvVarSpec
  value: string
  onChange: (v: string) => void
  isSecretSet: boolean
  /** Secret is marked to be emptied on the next apply. */
  cleared?: boolean
  /** Toggle clearing a set secret. Omitted ⇒ no Clear affordance. */
  onClear?: (clear: boolean) => void
}) {
  // A set secret is shown blank (the value is never sent to the browser), so
  // an empty input means "unchanged". Clearing therefore needs an explicit
  // action — offered only for optional vars.
  const canClear =
    spec.type === 'secret' && isSecretSet && !spec.required && !!onClear
  const error = spec.validate && value.trim() ? spec.validate(value) : null
  // A bool shows what Ask actually does: unset falls back to the app's own
  // default (e.g. RECALL_ENABLED unset = ON), not a blanket "off".
  const boolUnset = spec.type === 'bool' && value === ''
  const boolOn =
    spec.type === 'bool' &&
    boolIsOn(spec, boolUnset ? (spec.default ?? '') : value)

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
        {spec.readOnly ? (
          <>
            <Input
              id={spec.key}
              type="text"
              value={value}
              readOnly
              aria-readonly="true"
              className="font-mono text-muted-foreground"
              placeholder={spec.default ?? 'not set'}
            />
            {spec.help && (
              <p className="text-xs text-muted-foreground">{spec.help}</p>
            )}
          </>
        ) : spec.type === 'bool' ? (
          <div className="flex h-9 items-center gap-2.5">
            <Switch
              id={spec.key}
              checked={boolOn}
              onCheckedChange={c => onChange(boolLiteral(spec, c))}
            />
            <span className="text-sm text-muted-foreground">
              {boolOn ? 'Enabled' : 'Disabled'}
              {boolUnset && ' (default)'}
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
        ) : cleared ? (
          <div className="flex h-9 items-center gap-2.5">
            <span className="text-sm text-destructive">
              Will be cleared on apply
            </span>
            <button
              type="button"
              onClick={() => onClear?.(false)}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Undo
            </button>
          </div>
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
        {canClear && !cleared && !value && (
          <button
            type="button"
            onClick={() => onClear?.(true)}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
          >
            Clear this secret
          </button>
        )}
        {error && (
          <p className="text-xs font-medium text-destructive">{error}</p>
        )}
        {spec.testable && <TestButton spec={spec} value={value} />}
      </div>
    </div>
  )
}
