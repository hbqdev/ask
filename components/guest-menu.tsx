'use client'

import { useState } from 'react'
import Link from 'next/link'

import { IconSettings as Settings2 } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'

import { SettingsDialog } from './settings-dialog'

export default function GuestMenu() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button asChild variant="outline" size="sm">
        <Link href="/auth/login">Sign In</Link>
      </Button>
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
