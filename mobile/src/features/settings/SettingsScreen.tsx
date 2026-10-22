import { READABLE } from '@/core/ui/classes'
import {
  AboutSection,
  AccountSection,
  AnswersSection,
  AppearanceSection,
  DataSection,
  MemorySection,
  PersonalizationSection,
  VoiceSection
} from '@/features/settings/SettingsSections'

/**
 * The Settings tab: the account, how questions are answered, how answers
 * are read aloud, custom instructions, the way to Memory, the theme,
 * deleting all chats, and about the app.
 */
export function SettingsScreen() {
  return (
    // The scroller spans the screen; on an iPad the sections sit in the
    // readable column inside it.
    <main data-scroll-root className="flex-1 overflow-y-auto">
      <div className={`${READABLE} flex flex-col gap-8 px-4 pt-6 pb-8`}>
        <h1 className="px-2 text-3xl font-bold tracking-tight">Settings</h1>
        <AccountSection />
        <AnswersSection />
        <VoiceSection />
        <PersonalizationSection />
        <MemorySection />
        <AppearanceSection />
        <DataSection />
        <AboutSection />
      </div>
    </main>
  )
}
