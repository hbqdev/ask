'use client'

import React, { useState } from 'react'

import { IconClockX as ClockX } from '@tabler/icons-react'

interface Attachment {
  name: string | undefined
  url?: string
  contentType: string
}

interface AttachmentPreviewProps {
  attachments: Attachment[]
}

const EXPIRED_TITLE = 'Expired — re-upload to use again'

// Same footprint as the image tile below, shown when a stored attachment can
// no longer be fetched (its object was tombstoned/removed by the upload TTL
// sweep, so the URL now 404s) instead of a broken image.
function ExpiredPlaceholder({ name }: { name?: string }) {
  return (
    <div
      className="flex size-16 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed bg-muted/20 text-amber-500"
      title={EXPIRED_TITLE}
      aria-label={name ? `${name}: ${EXPIRED_TITLE}` : EXPIRED_TITLE}
    >
      <ClockX className="size-5 shrink-0" aria-hidden />
      <span className="text-[10px] leading-none">Expired</span>
    </div>
  )
}

// An attachment image that falls back to the expired placeholder when it
// fails to load (e.g. the underlying upload has expired and been removed).
function AttachmentImage({ url, name }: { url: string; name?: string }) {
  const [failed, setFailed] = useState(false)

  if (failed) return <ExpiredPlaceholder name={name} />

  return (
    <div className="flex size-16 items-center justify-center overflow-hidden rounded-md border bg-muted/20">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name ?? 'Attachment'}
        className="size-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  )
}

export const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({
  attachments
}) => {
  if (!attachments?.length) return null

  return (
    <div className="flex flex-wrap gap-4">
      {attachments.map((att, index) => {
        const isImage = att.contentType.startsWith('image/')
        const isPdf = att.contentType === 'application/pdf'
        const url = att.url

        return (
          <div key={index} className="max-w-xs break-words">
            {!url ? (
              <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                {att.name ?? 'File'} unavailable
              </div>
            ) : isImage ? (
              <AttachmentImage url={url} name={att.name} />
            ) : isPdf ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline"
              >
                📄 {att.name}
              </a>
            ) : (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline"
              >
                📎 {att.name}
              </a>
            )}
          </div>
        )
      })}
    </div>
  )
}
