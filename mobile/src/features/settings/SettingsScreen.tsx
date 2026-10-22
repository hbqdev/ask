import {
  AboutSection,
  AccountSection,
  AnswersSection,
  AppearanceSection,
  DataSection,
  PersonalizationSection,
  VoiceSection
} from '@/features/settings/SettingsSections'

/**
 * The Settings tab: the account, how questions are answered, how answers
 * are read aloud, custom instructions, the theme, deleting all chats, and
 * about the app.
 */
export function SettingsScreen() {
  return (
    <main className="flex flex-1 flex-col gap-8 overflow-y-auto px-4 pt-6 pb-8">
      <h1 className="px-2 text-3xl font-bold tracking-tight">Settings</h1>
      <AccountSection />
      <AnswersSection />
      <VoiceSection />
      <PersonalizationSection />
      <AppearanceSection />
      <DataSection />
      <AboutSection />
    </main>
  )
}
