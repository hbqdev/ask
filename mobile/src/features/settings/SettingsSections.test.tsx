import { Preferences } from '@capacitor/preferences'
import type { Session } from '@supabase/supabase-js'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Tabs, type TabSpec } from '@/app/Tabs'
import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { onChatsChanged } from '@/core/chats-events'
import { StackProvider } from '@/core/nav/stack'
import { resetModelChoice } from '@/features/compose/model-choice'
import { SEARCH_SETTINGS_KEY } from '@/features/compose/search-settings'
import {
  SearchSettingsProvider,
  useSharedSearchSettings
} from '@/features/compose/SearchSettingsProvider'
import { LIBRARY_CACHE_KEY } from '@/features/library/library-cache'
import { openMemory } from '@/features/settings/MemoryScreen'
import { CUSTOM_INSTRUCTIONS_KEY } from '@/features/settings/custom-instructions'
import {
  AboutSection,
  AccountSection,
  AnswersSection,
  DataSection,
  DELETE_ALL_ERROR,
  INSTRUCTIONS_SAVE_ERROR,
  MemorySection,
  PersonalizationSection,
  VOICE_SAMPLE_TEXT,
  VoiceSection
} from '@/features/settings/SettingsSections'
import { playingOwner, stop as stopPlayer } from '@/features/voice/speech'
import { VOICE_SETTINGS_KEY } from '@/features/voice/voice-settings'
import { TTS_SPEEDS, TTS_VOICES } from '@/lib/voice/voices'
import { installFakeAudio, resetFakeAudio } from '@/test/fake-audio'
import type { ModelSelectorData } from '@/lib/types/model-selector'
import { memoryStorage } from '@/test/memory-storage'

// --- Mocks ------------------------------------------------------------------

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))
vi.mock('@/features/settings/MemoryScreen', () => ({ openMemory: vi.fn() }))

const prefs = vi.hoisted(() => new Map<string, string>())
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefs.get(key) ?? null
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      prefs.set(key, value)
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      prefs.delete(key)
    })
  }
}))

type AppStateListener = (state: { isActive: boolean }) => void
const app = vi.hoisted(() => ({
  listeners: [] as Array<(state: { isActive: boolean }) => void>,
  remove: vi.fn(async () => {}),
  getInfo: vi.fn<() => Promise<{ version: string; build: string }>>()
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, listener: AppStateListener) => {
      app.listeners.push(listener)
      return {
        remove: async () => {
          app.listeners.splice(app.listeners.indexOf(listener), 1)
          await app.remove()
        }
      }
    }),
    getInfo: app.getInfo
  }
}))

const BASE = 'https://ask.test.invalid'

const MODELS: ModelSelectorData = {
  enabled: true,
  hasAvailableModels: true,
  selectedModelKey: 'ollama:qwen3',
  modelsByProvider: {
    Ollama: [
      { id: 'qwen3', name: 'Qwen 3', provider: 'Ollama', providerId: 'ollama' }
    ],
    Cloud: [
      { id: 'kimi', name: 'Kimi', provider: 'Cloud', providerId: 'cloud' }
    ]
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

type Route = (init?: RequestInit) => Promise<Response>

/** A fake Ask server, by "METHOD /path". */
function serve(routes: Record<string, Route> = {}) {
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).slice(BASE.length)}`
      const route = routes[key]
      if (!route) throw new Error(`unexpected request ${key}`)
      return route(init)
    }
  )
  const client = createApiClient({
    baseUrl: BASE,
    getToken: async () => 'token',
    fetchImpl
  })
  vi.mocked(useApi).mockReturnValue({
    client,
    baseUrl: BASE,
    getToken: async () => 'token'
  } satisfies Api)
  return fetchImpl
}

const session = {
  access_token: 'fake-access-token',
  user: { id: 'user-1', email: 'user@example.test' }
} as unknown as Session

function fakeAuth(overrides: Partial<Auth> = {}): Auth {
  const auth: Auth = {
    status: 'signedIn',
    session,
    error: null,
    signIn: vi.fn(async () => true),
    signInWithGoogle: vi.fn(async () => true),
    signOut: vi.fn(async () => {}),
    getAccessToken: vi.fn(async () => null),
    ...overrides
  }
  vi.mocked(useAuth).mockReturnValue(auth)
  return auth
}

/** Lets pending promises (storage, fetches) settle. */
const flush = () => act(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  resetModelChoice()
  prefs.clear()
  app.listeners.length = 0
  // As on the web: the native app info is not there.
  app.getInfo.mockRejectedValue(new Error('Not implemented on web.'))
})

// --- Account ----------------------------------------------------------------

describe('AccountSection', () => {
  const signOutRow = () => screen.getByRole('button', { name: 'Sign out' })

  it('shows the email, asks first, then signs out', async () => {
    let finish: () => void = () => {}
    const auth = fakeAuth({
      signOut: vi.fn(() => new Promise<void>(resolve => (finish = resolve)))
    })
    render(<AccountSection />)
    expect(screen.getByText('user@example.test')).toBeInTheDocument()

    fireEvent.click(signOutRow())
    expect(auth.signOut).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Sign out?' })
    const confirm = within(dialog).getByRole('button', { name: 'Sign out' })
    expect(confirm).toHaveClass('bg-red-600')

    fireEvent.click(confirm)
    expect(auth.signOut).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    // Pending until the sign-out ends: shown, and not asked for twice.
    const busy = screen.getByRole('button', { name: 'Signing out…' })
    expect(busy).toBeDisabled()

    await act(async () => finish())
    expect(signOutRow()).toBeEnabled()
  })

  it('Cancel keeps the user signed in', () => {
    const auth = fakeAuth()
    render(<AccountSection />)
    fireEvent.click(signOutRow())
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it('Sign out is a destructive row', () => {
    fakeAuth()
    serve()
    render(<AccountSection />)
    expect(signOutRow()).toHaveClass('text-destructive')
  })

  it('ends with a destructive Delete account row that opens its sheet', () => {
    fakeAuth()
    serve()
    render(<AccountSection />)
    const rows = screen.getAllByRole('button')
    const row = screen.getByRole('button', { name: 'Delete account' })
    expect(rows.at(-1)).toBe(row)
    expect(row).toHaveClass('text-destructive')

    fireEvent.click(row)
    const dialog = screen.getByRole('dialog', { name: 'Delete account?' })
    expect(
      within(dialog).getByLabelText('Type DELETE to confirm')
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still offers Sign out when the session has no email', () => {
    fakeAuth({
      session: { ...session, user: { id: 'user-1' } } as unknown as Session
    })
    render(<AccountSection />)
    expect(screen.queryByText('Signed in as')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })
})

// --- Answers ----------------------------------------------------------------

describe('AnswersSection', () => {
  /** What the composer's chip reads: the shared settings. */
  function SharedProbe() {
    const [settings] = useSharedSearchSettings()
    return (
      <p data-testid="shared">
        {settings.searchMode}:{settings.sources.join(',')}
      </p>
    )
  }

  async function renderAnswers(storage = memoryStorage()) {
    render(
      <SearchSettingsProvider storage={storage}>
        <AnswersSection />
        <SharedProbe />
      </SearchSettingsProvider>
    )
    await flush()
    return storage
  }

  it('changes the shared search mode', async () => {
    serve({ 'GET /api/models': async () => json(MODELS) })
    const storage = await renderAnswers()
    const group = screen.getByRole('radiogroup', { name: 'Search mode' })
    expect(
      within(group).getByRole('radio', { name: 'Balanced' })
    ).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(within(group).getByRole('radio', { name: 'Quality' }))
    expect(
      within(group).getByRole('radio', { name: 'Quality' })
    ).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('shared')).toHaveTextContent('quality:web')
    await flush()
    expect(JSON.parse(storage.data.get(SEARCH_SETTINGS_KEY)!)).toEqual({
      searchMode: 'quality',
      sources: ['web']
    })
  })

  it('toggles the shared sources and keeps the last one on', async () => {
    serve({ 'GET /api/models': async () => json(MODELS) })
    await renderAnswers()
    const web = screen.getByRole('button', { name: 'Web' })
    expect(web).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(web)
    expect(screen.getByTestId('shared')).toHaveTextContent('balanced:web')

    fireEvent.click(screen.getByRole('button', { name: 'Academic' }))
    expect(screen.getByTestId('shared')).toHaveTextContent(
      'balanced:web,academic'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Web' }))
    expect(screen.getByTestId('shared')).toHaveTextContent('balanced:academic')
  })

  it('shows the model picker, which saves a pick on the server', async () => {
    const fetchImpl = serve({
      'GET /api/models': async () => json(MODELS),
      'PUT /api/settings/model': async () =>
        json({ ok: true, selectedModelKey: 'cloud:kimi' })
    })
    await renderAnswers()
    const group = screen.getByRole('radiogroup', { name: 'Model' })
    await act(async () =>
      fireEvent.click(within(group).getByRole('radio', { name: 'Kimi' }))
    )
    expect(within(group).getByRole('radio', { name: 'Kimi' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    const put = fetchImpl.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      providerId: 'cloud',
      modelId: 'kimi'
    })
  })
})

// --- Personalization --------------------------------------------------------

describe('PersonalizationSection', () => {
  const field = () =>
    screen.getByRole('textbox', { name: 'Custom instructions' })

  async function renderPersonalization(stored?: string) {
    if (stored !== undefined) prefs.set(CUSTOM_INSTRUCTIONS_KEY, stored)
    const view = render(<PersonalizationSection />)
    await flush()
    return view
  }

  const type = (text: string) =>
    fireEvent.change(field(), { target: { value: text } })

  it('shows the saved instructions with a 4000-character counter', async () => {
    await renderPersonalization('Be brief.')
    expect(field()).toHaveValue('Be brief.')
    expect(field()).toHaveAttribute('maxLength', '4000')
    expect(screen.getByText('9/4000')).toBeInTheDocument()
    type('Be brief, please.')
    expect(screen.getByText('17/4000')).toBeInTheDocument()
  })

  it('saves on blur, trimmed, and says Saved', async () => {
    await renderPersonalization()
    type('  Use British English.  ')
    expect(screen.queryByText('Saved')).toBeNull()
    fireEvent.blur(field())
    await flush()
    expect(prefs.get(CUSTOM_INSTRUCTIONS_KEY)).toBe('Use British English.')
    expect(screen.getByText('Saved')).toBeInTheDocument()

    // Editing again hides the hint until the next save.
    type('Use British English!')
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('does not save a blur that changed nothing', async () => {
    await renderPersonalization('Be brief.')
    fireEvent.blur(field())
    type('Be brief.  ')
    fireEvent.blur(field())
    await flush()
    expect(Preferences.set).not.toHaveBeenCalled()
    expect(Preferences.remove).not.toHaveBeenCalled()
  })

  it('clearing the field removes the instructions', async () => {
    await renderPersonalization('Be brief.')
    type('   ')
    fireEvent.blur(field())
    await flush()
    expect(prefs.has(CUSTOM_INSTRUCTIONS_KEY)).toBe(false)
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('a failed save shows an error and the next blur tries again', async () => {
    await renderPersonalization()
    vi.mocked(Preferences.set).mockRejectedValueOnce(new Error('full'))
    type('Be brief.')
    fireEvent.blur(field())
    await flush()
    expect(screen.getByText(INSTRUCTIONS_SAVE_ERROR)).toBeInTheDocument()
    expect(screen.queryByText('Saved')).toBeNull()

    fireEvent.blur(field())
    await flush()
    expect(prefs.get(CUSTOM_INSTRUCTIONS_KEY)).toBe('Be brief.')
    expect(screen.queryByText(INSTRUCTIONS_SAVE_ERROR)).toBeNull()
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('text typed before the stored value loads is kept', async () => {
    prefs.set(CUSTOM_INSTRUCTIONS_KEY, 'Old text')
    let release: () => void = () => {}
    vi.mocked(Preferences.get).mockImplementationOnce(
      ({ key }) =>
        new Promise(resolve => {
          release = () => resolve({ value: prefs.get(key) ?? null })
        })
    )
    render(<PersonalizationSection />)
    type('New text')
    await act(async () => release())
    expect(field()).toHaveValue('New text')
  })

  it('saves when the screen goes away', async () => {
    const { unmount } = await renderPersonalization()
    type('Answer in French.')
    unmount()
    await flush()
    expect(prefs.get(CUSTOM_INSTRUCTIONS_KEY)).toBe('Answer in French.')
  })

  it('saves when its tab is left', async () => {
    const tabs: TabSpec[] = [
      {
        id: 'ask',
        label: 'Ask',
        icon: <svg />,
        render: () => <p>Ask</p>
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: <svg />,
        render: () => <PersonalizationSection />
      }
    ]
    render(<Tabs tabs={tabs} initial="settings" />)
    await flush()
    type('Answer in French.')
    fireEvent.click(screen.getByRole('tab', { name: 'Ask' }))
    await flush()
    expect(prefs.get(CUSTOM_INSTRUCTIONS_KEY)).toBe('Answer in French.')
  })

  it('saves when the app goes to the background', async () => {
    const { unmount } = await renderPersonalization()
    type('Answer in French.')
    act(() => {
      for (const listener of app.listeners) listener({ isActive: true })
    })
    await flush()
    expect(Preferences.set).not.toHaveBeenCalled()
    act(() => {
      for (const listener of app.listeners) listener({ isActive: false })
    })
    await flush()
    expect(prefs.get(CUSTOM_INSTRUCTIONS_KEY)).toBe('Answer in French.')
    unmount()
    await flush()
    expect(app.remove).toHaveBeenCalled()
  })
})

// --- Memory -----------------------------------------------------------------

describe('MemorySection', () => {
  it('its note is 60% foreground (AA on the page), not 50%', () => {
    render(
      <StackProvider root={{ key: 'tabs', render: () => null }}>
        <MemorySection />
      </StackProvider>
    )
    expect(screen.getByText(/What Ask remembers about you/)).toHaveClass(
      'text-foreground/60'
    )
  })

  it('opens the Memory screen', () => {
    render(
      <StackProvider root={{ key: 'tabs', render: () => null }}>
        <MemorySection />
      </StackProvider>
    )
    expect(
      screen.getByRole('heading', { level: 2, name: 'Memory' })
    ).toBeInTheDocument()
    expect(openMemory).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: 'Memory and past chats' })
    )
    expect(openMemory).toHaveBeenCalledOnce()
    expect(openMemory).toHaveBeenCalledWith(expect.any(Function))
  })
})

// --- Voice ------------------------------------------------------------------

describe('VoiceSection', () => {
  const speakMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    serve()
    installFakeAudio()
    resetFakeAudio()
    speakMock.mockReset()
    speakMock.mockImplementation(
      async () =>
        new Response('mp3', { headers: { 'Content-Type': 'audio/mpeg' } })
    )
    vi.stubGlobal('fetch', speakMock)
  })

  afterEach(() => {
    stopPlayer()
    vi.unstubAllGlobals()
  })

  const stored = () => JSON.parse(prefs.get(VOICE_SETTINGS_KEY) ?? 'null')

  async function renderVoice() {
    const utils = render(<VoiceSection />)
    await flush()
    return utils
  }

  it('has auto-read off, Ask’s voice and speed checked, by default', async () => {
    await renderVoice()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Voice' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('switch', { name: 'Read answers aloud' })
    ).toHaveAttribute('aria-checked', 'false')
    expect(
      screen.getByRole('radio', { name: 'Heart — US, warm (default)' })
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByRole('radio', { name: 'A bit faster (1.2×)' })
    ).toHaveAttribute('aria-checked', 'true')
  })

  it('calls the voice picker Narrator, under the Voice section', async () => {
    await renderVoice()
    expect(
      screen.getByRole('heading', { level: 3, name: 'Narrator' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { level: 3, name: 'Voice' })
    ).toBeNull()
    expect(
      screen.getByRole('radiogroup', { name: 'Narrator' })
    ).toBeInTheDocument()
  })

  it('the speed is a segmented control: the chosen speed is the thumb', async () => {
    await renderVoice()
    const speeds = screen.getByRole('radiogroup', { name: 'Speed' })
    expect(speeds).toHaveClass('bg-muted')
    for (const radio of within(speeds).getAllByRole('radio')) {
      const checked = radio.getAttribute('aria-checked') === 'true'
      expect(radio.classList.contains('bg-thumb'), radio.textContent!).toBe(
        checked
      )
    }
    expect(
      screen.getByRole('radio', { name: 'A bit faster (1.2×)' })
    ).toHaveClass('bg-thumb')
  })

  it('lists every voice and speed', async () => {
    await renderVoice()
    const voices = within(screen.getByRole('radiogroup', { name: 'Narrator' }))
    expect(voices.getAllByRole('radio').map(r => r.textContent)).toEqual(
      TTS_VOICES.map(v => v.label)
    )
    const speeds = within(screen.getByRole('radiogroup', { name: 'Speed' }))
    expect(
      speeds.getAllByRole('radio').map(r => r.getAttribute('aria-label'))
    ).toEqual(TTS_SPEEDS.map(s => s.label))
    expect(speeds.getAllByRole('radio').map(r => r.textContent)).toEqual(
      TTS_SPEEDS.map(s => `${s.value}×`)
    )
  })

  it('shows the stored settings', async () => {
    prefs.set(
      VOICE_SETTINGS_KEY,
      JSON.stringify({ voice: 'bm_george', speed: 0.9, autoRead: true })
    )
    await renderVoice()
    expect(
      screen.getByRole('switch', { name: 'Read answers aloud' })
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByRole('radio', { name: 'George — UK male' })
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByRole('radio', { name: 'Slower (0.9×)' })
    ).toHaveAttribute('aria-checked', 'true')
  })

  it('turns auto-read on and off, and saves it', async () => {
    await renderVoice()
    const toggle = screen.getByRole('switch', { name: 'Read answers aloud' })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await flush()
    expect(stored()).toEqual({ voice: 'af_heart', speed: 1.2, autoRead: true })
    fireEvent.click(toggle)
    await flush()
    expect(stored().autoRead).toBe(false)
  })

  it('picks a voice and a speed, and saves them', async () => {
    await renderVoice()
    fireEvent.click(screen.getByRole('radio', { name: 'Emma — UK female' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Fast (1.4×)' }))
    await flush()
    expect(stored()).toEqual({ voice: 'bf_emma', speed: 1.4, autoRead: false })
    expect(
      screen.getByRole('radio', { name: 'Emma — UK female' })
    ).toHaveAttribute('aria-checked', 'true')
  })

  it('two quick picks before a render keep both', async () => {
    await renderVoice()
    const emma = screen.getByRole('radio', { name: 'Emma — UK female' })
    const fast = screen.getByRole('radio', { name: 'Fast (1.4×)' })
    const toggle = screen.getByRole('switch', { name: 'Read answers aloud' })
    act(() => {
      emma.click()
      fast.click()
      toggle.click()
    })
    await flush()
    expect(stored()).toEqual({ voice: 'bf_emma', speed: 1.4, autoRead: true })
    expect(emma).toHaveAttribute('aria-checked', 'true')
    expect(fast).toHaveAttribute('aria-checked', 'true')
  })

  it('picking the voice already chosen changes nothing', async () => {
    await renderVoice()
    fireEvent.click(
      screen.getByRole('radio', { name: 'Heart — US, warm (default)' })
    )
    fireEvent.click(screen.getByRole('radio', { name: 'A bit faster (1.2×)' }))
    await flush()
    expect(Preferences.set).not.toHaveBeenCalled()
  })

  it('plays a sample in the chosen voice and speed, and stops it', async () => {
    await renderVoice()
    fireEvent.click(screen.getByRole('radio', { name: 'Adam — US male' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Faster (1.6×)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Play sample' }))
    expect(
      screen.getByRole('button', { name: 'Loading sample' })
    ).toBeInTheDocument()
    const stopButton = await screen.findByRole('button', {
      name: 'Stop sample'
    })

    const [url, init] = speakMock.mock.calls[0]
    expect(String(url)).toBe(`${BASE}/api/voice/speak`)
    expect(JSON.parse(String(init?.body))).toEqual({
      text: VOICE_SAMPLE_TEXT,
      voice: 'am_adam',
      speed: 1.6
    })

    fireEvent.click(stopButton)
    expect(playingOwner()).toBeNull()
    expect(screen.getByRole('button', { name: 'Play sample' })).toBeVisible()
  })

  it('says why a sample could not play', async () => {
    speakMock.mockImplementation(
      async () => new Response('TTS unavailable', { status: 503 })
    )
    await renderVoice()
    fireEvent.click(screen.getByRole('button', { name: 'Play sample' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Voice is unavailable right now'
    )
  })

  it('leaving the Settings tab stops the sample', async () => {
    const tabs: TabSpec[] = [
      {
        id: 'ask',
        label: 'Ask',
        icon: <svg />,
        render: () => <p>Ask</p>
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: <svg />,
        render: () => <VoiceSection />
      }
    ]
    render(<Tabs tabs={tabs} initial="settings" />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Play sample' }))
    await screen.findByRole('button', { name: 'Stop sample' })
    fireEvent.click(screen.getByRole('tab', { name: 'Ask' }))
    expect(playingOwner()).toBeNull()
  })
})

// --- Data -------------------------------------------------------------------

describe('DataSection', () => {
  const changed = vi.fn()
  let unsubscribe: () => void
  beforeEach(() => {
    unsubscribe = onChatsChanged(changed)
  })
  afterEach(() => unsubscribe())

  const deleteAll = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Delete all chats' }))
  const confirm = () =>
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Delete all'
    })

  it('Delete all chats is a destructive row', () => {
    serve()
    render(<DataSection />)
    expect(
      screen.getByRole('button', { name: 'Delete all chats' })
    ).toHaveClass('text-destructive')
  })

  it('asks first, then deletes every chat, clears the cache and tells the Library', async () => {
    let answer: (res: Response) => void = () => {}
    const fetchImpl = serve({
      'DELETE /api/chats': () => new Promise(resolve => (answer = resolve))
    })
    prefs.set(LIBRARY_CACHE_KEY, '{"userId":"user-1"}')
    render(<DataSection />)

    deleteAll()
    expect(fetchImpl).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Delete all chats?' })
    expect(confirm()).toHaveClass('bg-red-600')
    expect(dialog).toBeInTheDocument()

    await act(async () => fireEvent.click(confirm()))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const busy = screen.getByRole('button', { name: 'Deleting…' })
    expect(busy).toBeDisabled()

    await act(async () => answer(json({ ok: true })))
    expect(prefs.has(LIBRARY_CACHE_KEY)).toBe(false)
    expect(changed).toHaveBeenCalledWith('cleared')
    expect(screen.getByText('All chats deleted.')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Delete all chats' })
    ).toBeEnabled()
  })

  it('Cancel deletes nothing', async () => {
    const fetchImpl = serve()
    render(<DataSection />)
    deleteAll()
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })
    )
    await flush()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a failed delete shows an error and keeps the cache', async () => {
    serve({
      'DELETE /api/chats': async () =>
        json({ error: 'boom', retryable: true }, 500)
    })
    prefs.set(LIBRARY_CACHE_KEY, '{"userId":"user-1"}')
    render(<DataSection />)
    deleteAll()
    await act(async () => fireEvent.click(confirm()))
    expect(screen.getByRole('alert')).toHaveTextContent(DELETE_ALL_ERROR)
    expect(prefs.has(LIBRARY_CACHE_KEY)).toBe(true)
    expect(changed).not.toHaveBeenCalled()
  })

  it('still tells the Library when the cache cannot be cleared', async () => {
    serve({ 'DELETE /api/chats': async () => json({ ok: true }) })
    vi.mocked(Preferences.remove).mockRejectedValueOnce(new Error('locked'))
    render(<DataSection />)
    deleteAll()
    await act(async () => fireEvent.click(confirm()))
    expect(changed).toHaveBeenCalledWith('cleared')
    expect(screen.getByText('All chats deleted.')).toBeInTheDocument()
  })
})

// --- About ------------------------------------------------------------------

describe('AboutSection', () => {
  it('shows the installed app’s version and the server host', async () => {
    app.getInfo.mockResolvedValue({ version: '1.4.0', build: '12' })
    serve()
    render(<AboutSection />)
    expect(await screen.findByText('1.4.0')).toBeInTheDocument()
    expect(screen.queryByText('0.0.0-test')).toBeNull()
    expect(screen.getByText('ask.test.invalid')).toBeInTheDocument()
  })

  it('shows the bundled version where the app info is not available (the web)', async () => {
    serve()
    render(<AboutSection />)
    await flush()
    expect(app.getInfo).toHaveBeenCalled()
    expect(screen.getByText('0.0.0-test')).toBeInTheDocument()
  })
})
