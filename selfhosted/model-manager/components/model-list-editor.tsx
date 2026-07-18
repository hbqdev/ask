'use client'

import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { useState } from 'react'
import {
  addItem,
  move,
  parseList,
  removeAt,
  serializeList
} from '@/lib/model-list'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ModelListEditor({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}) {
  const items = parseList(value)
  const [draft, setDraft] = useState('')
  const emit = (next: string[]) => onChange(serializeList(next))

  return (
    <div className="space-y-1.5">
      {items.map((item, i) => (
        <div key={`${item}-${i}`} className="flex items-center gap-1">
          <span className="flex-1 truncate rounded bg-muted px-2 py-1 text-sm">
            {item}
          </span>
          {i > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="move up"
              onClick={() => emit(move(items, i, i - 1))}
            >
              <ChevronUp className="size-4" />
            </Button>
          )}
          {i < items.length - 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="move down"
              onClick={() => emit(move(items, i, i + 1))}
            >
              <ChevronDown className="size-4" />
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="remove"
            onClick={() => emit(removeAt(items, i))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <Input
          placeholder="Add model…"
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <Button
          type="button"
          size="icon"
          aria-label="add"
          onClick={() => {
            emit(addItem(items, draft))
            setDraft('')
          }}
        >
          <Plus className="size-4" />
        </Button>
      </div>
    </div>
  )
}
