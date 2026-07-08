'use client'

import { useState } from 'react'

import { IconSettings as Settings2 } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { SettingsDialog } from './settings-dialog'

export default function GuestMenu() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        onClick={() => setOpen(true)}
      >
        <Settings2 className="size-4" />
        <span className="sr-only">Open settings</span>
      </Button>
      <SettingsDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
