'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import type { User } from '@supabase/supabase-js'
import {
  IconAdjustments,
  IconChevronLeft,
  IconNotes,
  IconPalette,
  IconTrash,
  IconUserCircle
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { deleteAccount, updateEmail } from '@/lib/actions/account'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

import { MemoryTab } from '@/components/settings/memory-tab'
import { useTheme } from '@/components/theme-provider'

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------
function lsGet(key: string): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(key)
}
function lsSet(key: string, value: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(key, value)
  window.dispatchEvent(
    new CustomEvent('client-config-changed', { detail: key })
  )
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------
const TABS = [
  {
    key: 'preferences',
    label: 'Preferences',
    description: 'Customize your application preferences.',
    icon: IconAdjustments
  },
  {
    key: 'personalization',
    label: 'Personalization',
    description: 'Customize the behavior and tone of the model.',
    icon: IconPalette
  },
  {
    key: 'memory',
    label: 'Memory',
    description: 'Manage what Ask remembers about you.',
    icon: IconNotes
  },
  {
    key: 'account',
    label: 'Account',
    description: 'Manage your profile and account data.',
    icon: IconUserCircle
  }
] as const
type TabKey = (typeof TABS)[number]['key']

// ---------------------------------------------------------------------------
// Vane-style card — matches `rounded-xl border border-light-200 bg-light-primary/80 p-4 lg:p-6`
// ---------------------------------------------------------------------------
export function SettingRow({
  title,
  description,
  children,
  inline = false
}: {
  title: string
  description: string
  children: React.ReactNode
  inline?: boolean
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-background/80 p-4 lg:p-6 transition-colors flex',
        inline
          ? 'flex-row items-center justify-between gap-5'
          : 'flex-col gap-0'
      )}
    >
      <div className={cn('flex flex-col', !inline && 'mb-3 lg:mb-5')}>
        <h4 className="text-sm text-foreground">{title}</h4>
        <p className="text-[11px] lg:text-xs text-foreground/50">
          {description}
        </p>
      </div>
      <div className={cn(inline ? 'shrink-0' : 'w-full')}>{children}</div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Vane-style select — matches `bg-light-secondary dark:bg-dark-secondary border-light-200`
// ---------------------------------------------------------------------------
function SettingSelect({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="relative inline-flex w-full items-center">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="bg-muted px-3 py-2 flex items-center overflow-hidden border border-border text-foreground rounded-lg appearance-none w-full pr-10 text-xs lg:text-sm focus:outline-none"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 flex h-4 w-4 items-center justify-center text-foreground/50">
        <svg
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          className="h-4 w-4"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vane-style switch — `h-6 w-12 bg-muted data-checked:bg-sky-500`
// ---------------------------------------------------------------------------
export function SettingSwitch({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'group relative flex h-6 w-12 shrink-0 cursor-pointer rounded-full p-1 duration-200 ease-in-out focus:outline-none transition-colors',
        checked ? 'bg-sky-500' : 'bg-muted'
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block size-4 rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out',
          checked ? 'translate-x-6' : 'translate-x-0'
        )}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Preferences tab
// ---------------------------------------------------------------------------
function PreferencesTab() {
  const { theme, setTheme } = useTheme()
  const [measureUnit, setMeasureUnit] = useState('metric')
  const [showWeather, setShowWeather] = useState(true)
  const [showNews, setShowNews] = useState(true)

  useEffect(() => {
    // Reads localStorage after mount (client-only) — intentional, so the
    // initial render matches SSR and hydrates without a mismatch. The
    // set-state-in-effect rule is a false positive for this pattern.
    /* eslint-disable react-hooks/set-state-in-effect */
    setMeasureUnit(lsGet('measureUnit') ?? 'metric')
    setShowWeather(lsGet('showWeatherWidget') !== 'false')
    setShowNews(lsGet('showNewsWidget') !== 'false')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
      <SettingRow
        title="Theme"
        description="Choose between light and dark layouts for the app."
      >
        <SettingSelect
          value={theme ?? 'system'}
          onChange={v => setTheme(v)}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ]}
        />
      </SettingRow>

      <SettingRow
        title="Measurement Unit"
        description="Choose between Metric and Imperial measurement unit."
      >
        <SettingSelect
          value={measureUnit}
          onChange={v => {
            setMeasureUnit(v)
            lsSet('measureUnit', v)
          }}
          options={[
            { value: 'metric', label: 'Metric' },
            { value: 'imperial', label: 'Imperial' }
          ]}
        />
      </SettingRow>

      <SettingRow
        title="Show weather widget"
        description="Display the weather card on the home screen."
        inline
      >
        <SettingSwitch
          checked={showWeather}
          onChange={v => {
            setShowWeather(v)
            lsSet('showWeatherWidget', String(v))
          }}
        />
      </SettingRow>

      <SettingRow
        title="Show news widget"
        description="Display the recent news card on the home screen."
        inline
      >
        <SettingSwitch
          checked={showNews}
          onChange={v => {
            setShowNews(v)
            lsSet('showNewsWidget', String(v))
          }}
        />
      </SettingRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Personalization tab
// ---------------------------------------------------------------------------
function PersonalizationTab() {
  const [instructions, setInstructions] = useState('')

  useEffect(() => {
    // Reads localStorage after mount (client-only) — intentional, so the
    // initial render matches SSR and hydrates without a mismatch. The
    // set-state-in-effect rule is a false positive for this pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInstructions(lsGet('systemInstructions') ?? '')
  }, [])

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
      <SettingRow
        title="System Instructions"
        description='Add custom behavior or tone for the model. e.g. "Respond in a friendly and concise tone" or "Use British English."'
      >
        <textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          onBlur={() => lsSet('systemInstructions', instructions)}
          placeholder='e.g., "Respond in a friendly and concise tone"'
          rows={4}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 lg:px-4 lg:py-3 text-xs lg:text-[13px] text-foreground/80 placeholder:text-foreground/40 focus-visible:outline-none transition-colors resize-none"
        />
      </SettingRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Account tab — absorbed from the old standalone account dialog. Theme is
// deliberately not repeated here; it already lives under Preferences.
// ---------------------------------------------------------------------------
function AccountTab({
  user,
  onCloseDialog
}: {
  user: User
  onCloseDialog: () => void
}) {
  const router = useRouter()
  const [isDeleting, startDeleteTransition] = useTransition()
  const [confirmOpen, setConfirmOpen] = useState(false)

  const [newEmail, setNewEmail] = useState('')
  const [emailPending, startEmailTransition] = useTransition()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordPending, setPasswordPending] = useState(false)

  const userName =
    user.user_metadata?.full_name || user.user_metadata?.name || 'User'

  const handleEmailSave = (event: React.FormEvent) => {
    event.preventDefault()
    startEmailTransition(async () => {
      let result: Awaited<ReturnType<typeof updateEmail>>
      try {
        result = await updateEmail(newEmail)
      } catch {
        toast.error('Failed to change email — refresh the page and try again.')
        return
      }

      if (result.success) {
        toast.success('Email updated — sign in with the new address next time')
        setNewEmail('')
        // Re-fetch server components so the displayed profile email updates.
        router.refresh()
        return
      }

      toast.error(result.error ?? 'Failed to change email')
    })
  }

  const handlePasswordSave = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!user.email) {
      toast.error('No email on this account.')
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match.')
      return
    }
    if (newPassword.length < 6) {
      toast.error('New password must be at least 6 characters.')
      return
    }

    setPasswordPending(true)
    try {
      const supabase = createClient()
      // Supabase's updateUser doesn't ask for the old password, so verify it
      // ourselves first — otherwise anyone at an unlocked screen could set a
      // new one. Signing in again just refreshes the same session.
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword
      })
      if (verifyError) {
        toast.error('Current password is incorrect.')
        return
      }

      const { error } = await supabase.auth.updateUser({
        password: newPassword
      })
      if (error) {
        toast.error(error.message)
        return
      }

      toast.success('Password updated')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } finally {
      setPasswordPending(false)
    }
  }

  const handleDeleteAccount = () => {
    startDeleteTransition(async () => {
      // A rejected action (network failure, stale server action after a
      // redeploy) must surface, not die silently.
      let result: Awaited<ReturnType<typeof deleteAccount>>
      try {
        result = await deleteAccount()
      } catch {
        toast.error(
          'Failed to delete account — refresh the page and try again.'
        )
        return
      }

      if (result.success) {
        try {
          await createClient().auth.signOut()
        } catch (error) {
          console.error('Failed to clear client session:', error)
        }

        toast.success('Account deleted')
        setConfirmOpen(false)
        onCloseDialog()
        router.push('/')
        router.refresh()
        return
      }

      toast.error(result.error ?? 'Failed to delete account')
    })
  }

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
      <SettingRow title="Profile" description="The signed-in account.">
        <div className="text-sm text-muted-foreground">
          <p className="truncate">{userName}</p>
          <p className="truncate">{user.email}</p>
        </div>
      </SettingRow>

      <SettingRow
        title="Email"
        description="Change the address you sign in with. Takes effect immediately — no confirmation email."
      >
        <form
          onSubmit={handleEmailSave}
          className="flex flex-col sm:flex-row gap-2"
        >
          <Input
            type="email"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            placeholder={user.email ?? 'new@email.com'}
            autoComplete="email"
            required
            className="sm:max-w-xs"
          />
          <Button
            type="submit"
            variant="outline"
            className="w-fit"
            disabled={emailPending || !newEmail}
          >
            {emailPending ? <Spinner /> : 'Save email'}
          </Button>
        </form>
      </SettingRow>

      <SettingRow
        title="Password"
        description="Verify your current password, then choose a new one (6 characters minimum)."
      >
        <form
          onSubmit={handlePasswordSave}
          className="flex flex-col gap-2 sm:max-w-xs"
        >
          <Input
            type="password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            placeholder="Current password"
            autoComplete="current-password"
            required
          />
          <Input
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            placeholder="New password"
            autoComplete="new-password"
            required
          />
          <Input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder="Confirm new password"
            autoComplete="new-password"
            required
          />
          <Button
            type="submit"
            variant="outline"
            className="w-fit"
            disabled={
              passwordPending ||
              !currentPassword ||
              !newPassword ||
              !confirmPassword
            }
          >
            {passwordPending ? <Spinner /> : 'Update password'}
          </Button>
        </form>
      </SettingRow>

      <SettingRow
        title="Delete account"
        description="Permanently delete your account, chat history, and uploaded files. This action cannot be undone."
      >
        <AlertDialog
          open={confirmOpen}
          onOpenChange={nextOpen => {
            if (!isDeleting) {
              setConfirmOpen(nextOpen)
            }
          }}
        >
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="destructive"
              className="w-fit gap-2"
              disabled={isDeleting}
            >
              <IconTrash className="size-4" />
              Delete account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your account?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. Your account, chat history, and
                uploaded files will be permanently deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={isDeleting}
                onClick={event => {
                  event.preventDefault()
                  handleDeleteAccount()
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isDeleting ? <Spinner /> : 'Delete account'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------
interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Signed-in user; enables the Account tab when present. */
  user?: User | null
}

export function SettingsDialog({
  open,
  onOpenChange,
  user = null
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('preferences')
  // Guests have no Account tab; fall back if the stored tab is unavailable.
  const tabs = user ? TABS : TABS.filter(t => t.key !== 'account')
  const effectiveTab: TabKey = tabs.some(t => t.key === activeTab)
    ? activeTab
    : 'preferences'
  const activeSection = TABS.find(t => t.key === effectiveTab)!

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="
        max-w-none p-0 gap-0 overflow-hidden rounded-xl border border-border
        w-[calc(100vw-2%)] h-[calc(100vh-2%)]
        md:w-[calc(100vw-7%)] md:h-[calc(100vh-7%)]
        lg:w-[calc(100vw-30%)] lg:h-[calc(100vh-20%)]
      "
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex h-full overflow-hidden">
          {/* Sidebar — matches Vane: w-[240px] px-3 pt-3 */}
          <div className="hidden lg:flex flex-col justify-between w-[240px] shrink-0 border-r border-border h-full px-3 pt-3 overflow-y-auto">
            <div className="flex flex-col">
              {/* Back button — matches Vane: p-2 rounded-lg hover:bg-muted text-[14px] */}
              <button
                onClick={() => onOpenChange(false)}
                className="group flex flex-row items-center hover:bg-muted p-2 rounded-lg"
              >
                <IconChevronLeft
                  size={18}
                  className="text-foreground/50 group-hover:text-foreground/70"
                />
                <p className="text-foreground/50 group-hover:text-foreground/70 text-[14px]">
                  Back
                </p>
              </button>

              {/* Nav items — matches Vane: space-y-1 mt-8, px-2 py-1.5 */}
              <div className="flex flex-col items-start space-y-1 mt-8">
                {tabs.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={cn(
                      'flex flex-row items-center space-x-2 px-2 py-1.5 rounded-lg w-full text-sm hover:bg-muted transition duration-200 active:scale-95',
                      effectiveTab === key
                        ? 'bg-muted text-foreground/90'
                        : 'text-foreground/70'
                    )}
                  >
                    <Icon size={17} />
                    <p>{label}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Footer — matches Vane: py-[18px] px-2 */}
            <div className="flex flex-col space-y-1 py-[18px] px-2">
              <p className="text-xs text-foreground/70">Ask — self-hosted</p>
            </div>
          </div>

          {/* Content */}
          <div className="w-full flex flex-col overflow-hidden">
            {/* Mobile/tablet tab bar. The sidebar above is `hidden lg:flex`, so
                below the lg breakpoint it is gone entirely — without this row
                there is NO way to reach any tab but the default (Memory and
                Personalization become unreachable on any window narrower
                than 1024px). Shown only below lg, so it and the sidebar are
                mutually exclusive and cover every width. */}
            <div className="lg:hidden flex flex-row gap-1 overflow-x-auto border-b border-border/60 pl-3 pr-12 py-2 flex-shrink-0">
              {tabs.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={cn(
                    'flex flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap shrink-0 transition-colors active:scale-95',
                    effectiveTab === key
                      ? 'bg-muted text-foreground/90'
                      : 'text-foreground/70 hover:bg-muted'
                  )}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {/* Section header — matches Vane: border-b px-6 pb-6 lg:pt-6 */}
            <div className="border-b border-border/60 px-6 pb-6 pt-6 flex-shrink-0">
              <div className="flex flex-col">
                <h4 className="font-medium text-foreground text-sm">
                  {activeSection.label}
                </h4>
                <p className="text-[11px] lg:text-xs text-foreground/50">
                  {activeSection.description}
                </p>
              </div>
            </div>

            {/* Scrollable section content */}
            <div className="flex-1 overflow-y-auto">
              {effectiveTab === 'preferences' && <PreferencesTab />}
              {effectiveTab === 'personalization' && <PersonalizationTab />}
              {effectiveTab === 'memory' && <MemoryTab />}
              {effectiveTab === 'account' && user && (
                <AccountTab
                  user={user}
                  onCloseDialog={() => onOpenChange(false)}
                />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
