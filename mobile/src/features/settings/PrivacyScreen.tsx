// Privacy, pushed from Settings → About: where a user's data goes and who
// handles it (the copy is in privacy-copy.ts).

import { useApi } from '@/core/api/ApiProvider'
import { useStack, type Stack } from '@/core/nav/stack'
import { READABLE } from '@/core/ui/classes'
import { privacySections } from '@/features/settings/privacy-copy'

const BACK_ICON = 'M15 5l-7 7 7 7'

/** Opens the Privacy screen over the current one. */
export function openPrivacy(push: Stack['push']) {
  push({ key: 'settings:privacy', render: () => <PrivacyScreen /> })
}

/** The Privacy screen: a back header, then each section's heading and text. */
export function PrivacyScreen() {
  const { baseUrl } = useApi()
  const { pop } = useStack()
  const sections = privacySections(new URL(baseUrl).host)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="grid grid-cols-[48px_minmax(0,1fr)_48px] items-center border-b border-foreground/10 px-1 py-1">
        <button
          type="button"
          aria-label="Back"
          onClick={pop}
          className="flex size-11 touch-manipulation items-center justify-center rounded-full text-foreground/70 active:opacity-50"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-6"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={BACK_ICON} />
          </svg>
        </button>
        <h1 className="truncate text-center text-base font-semibold">
          Privacy
        </h1>
      </header>
      {/* A pushed screen covers the tab bar, so its content clears the home
          indicator; a status-bar tap scrolls it to the top. On an iPad the
          text sits in the readable column. */}
      <div
        data-scroll-root
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {/* .safe-bottom sets the bottom padding, so the spacing is inside. */}
        <div className={`safe-bottom ${READABLE}`}>
          <div className="selectable flex flex-col gap-6 px-4 pt-6 pb-8">
            {sections.map(section => (
              <section key={section.title} className="flex flex-col gap-2">
                <h2 className="text-lg font-semibold">{section.title}</h2>
                {section.paragraphs.map(paragraph => (
                  <p key={paragraph} className="text-base leading-relaxed">
                    {paragraph}
                  </p>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
