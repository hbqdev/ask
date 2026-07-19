'use client'

import { Check, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

type ApplyEvent = {
  step: string
  status: 'start' | 'ok' | 'fail'
  detail?: string
}
type Backup = { path: string; ts: string }

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
      {diff.split('\n').map((line, i) => {
        const cls = /^\s*\+/.test(line)
          ? 'text-emerald-600 dark:text-emerald-400'
          : /^\s*-/.test(line)
            ? 'text-destructive'
            : line.startsWith('~')
              ? 'font-medium text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground'
        return (
          <div key={i} className={cn('whitespace-pre-wrap font-mono', cls)}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

export function ApplyBar({ edits }: { edits: Record<string, string> }) {
  const count = Object.keys(edits).length
  const [diff, setDiff] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<ApplyEvent[]>([])
  const [applying, setApplying] = useState(false)

  const [backupsOpen, setBackupsOpen] = useState(false)
  const [backups, setBackups] = useState<Backup[]>([])
  const [restoring, setRestoring] = useState<string | null>(null)

  async function review() {
    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits })
      })
      if (!res.ok) {
        let msg = `Preview failed (HTTP ${res.status})`
        try {
          const j = (await res.json()) as {
            violations?: { key: string; error: string }[]
          }
          if (j?.violations?.length) {
            msg = `Invalid: ${j.violations.map(v => v.key).join(', ')}`
          }
        } catch {
          // response had no JSON body — keep the HTTP-status message
        }
        toast.error(msg)
        return
      }
      const body = (await res.json()) as { diff: string }
      setDiff(body.diff)
      setEvents([])
      setOpen(true)
    } catch (e) {
      toast.error(
        `Preview failed: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  async function apply() {
    setApplying(true)
    setEvents([])
    // Track failure locally as events stream in — `events` state only
    // reflects the last completed render, so reading it right after the loop
    // would see a stale (often empty) closure and could report success for a
    // run that actually failed.
    let sawFail = false
    try {
      const res = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits })
      })
      if (!res.ok || !res.body) {
        sawFail = true
        let detail = `Apply failed (HTTP ${res.status})`
        try {
          const j = (await res.json()) as {
            violations?: { key: string; error: string }[]
          }
          if (j?.violations?.length) {
            detail = `Invalid: ${j.violations.map(v => `${v.key} (${v.error})`).join(', ')}`
          }
        } catch {
          // response had no JSON body — keep the HTTP-status detail
        }
        setEvents(e => [...e, { step: 'apply', status: 'fail', detail }])
      } else {
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        const handleLine = (l: string) => {
          const evt = JSON.parse(l) as ApplyEvent
          if (evt.status === 'fail') sawFail = true
          setEvents(e => [...e, evt])
        }
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const l of lines) if (l.trim()) handleLine(l)
        }
        if (buf.trim()) handleLine(buf) // flush any trailing unterminated line
      }
      toast[sawFail ? 'error' : 'success'](
        sawFail ? 'Apply finished with errors' : 'Applied'
      )
    } catch (e) {
      toast.error(`Apply failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApplying(false)
    }
  }

  async function openBackups() {
    setBackupsOpen(true)
    try {
      const res = await fetch('/api/backups')
      const body = (await res.json()) as { backups: Backup[] }
      setBackups(body.backups)
    } catch (e) {
      toast.error(
        `Failed to load backups: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  async function restore(backupPath: string) {
    setRestoring(backupPath)
    try {
      const res = await fetch('/api/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backupPath })
      })
      const body = (await res.json()) as { ok: boolean }
      toast[body.ok ? 'success' : 'error'](
        body.ok ? 'Restored' : 'Restore failed'
      )
      if (body.ok) setBackupsOpen(false)
    } catch (e) {
      toast.error(
        `Restore failed: ${e instanceof Error ? e.message : String(e)}`
      )
    } finally {
      setRestoring(null)
    }
  }

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="text-sm">
            {count === 0 ? (
              <span className="text-muted-foreground">No pending changes</span>
            ) : (
              <span className="font-medium">
                {count} pending change{count === 1 ? '' : 's'}
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={openBackups}>
              Backups
            </Button>
            <Button size="sm" onClick={review} disabled={count === 0}>
              Review changes{count > 0 ? ` (${count})` : ''}
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review changes</DialogTitle>
          </DialogHeader>
          {diff ? (
            <DiffView diff={diff} />
          ) : (
            <p className="text-sm text-muted-foreground">No changes.</p>
          )}
          {events.length > 0 && (
            <ul className="max-h-40 space-y-1 overflow-auto rounded-lg border bg-muted/30 p-3 text-xs">
              {events.map((e, i) => (
                <li key={i} className="flex items-center gap-2">
                  {e.status === 'ok' ? (
                    <Check className="size-3.5 shrink-0 text-success" />
                  ) : e.status === 'fail' ? (
                    <X className="size-3.5 shrink-0 text-destructive" />
                  ) : (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  )}
                  <span
                    className={cn(
                      'truncate font-mono',
                      e.status === 'fail' && 'text-destructive'
                    )}
                  >
                    {e.step}
                    {e.detail ? ` — ${e.detail}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button onClick={apply} disabled={applying}>
              {applying ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Applying…
                </>
              ) : (
                'Save & Apply'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={backupsOpen} onOpenChange={setBackupsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Backups</DialogTitle>
          </DialogHeader>
          {backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No backups yet.</p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-auto text-sm">
              {backups.map(b => (
                <li
                  key={b.path}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {b.ts}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restoring === b.path}
                    onClick={() => restore(b.path)}
                  >
                    {restoring === b.path ? 'Restoring…' : 'Restore'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
