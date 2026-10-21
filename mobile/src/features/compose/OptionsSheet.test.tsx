import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import {
  MODEL_LOAD_ERROR,
  MODEL_SAVE_ERROR
} from '@/features/compose/ModelPicker'
import { resetModelChoice } from '@/features/compose/model-choice'
import { OptionsSheet } from '@/features/compose/OptionsSheet'
import type { SearchSettings } from '@/features/thread/chat-body'
import type { ModelSelectorData } from '@/lib/types/model-selector'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))

const BASE = 'https://ask.test.invalid'

const DATA: ModelSelectorData = {
  enabled: true,
  hasAvailableModels: true,
  selectedModelKey: 'ollama:qwen3',
  modelsByProvider: {
    Ollama: [
      { id: 'qwen3', name: 'Qwen 3', provider: 'Ollama', providerId: 'ollama' },
      { id: 'gemma', name: 'Gemma', provider: 'Ollama', providerId: 'ollama' }
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

/** A fake server: GET /api/models and PUT /api/settings/model by handler. */
function serve(routes: { models?: Route; save?: Route }) {
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(BASE.length)
      if (path === '/api/models' && routes.models) return routes.models(init)
      if (path === '/api/settings/model' && routes.save)
        return routes.save(init)
      throw new Error(`unexpected request ${path}`)
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

/** A response that arrives when the test says so. */
function deferred() {
  let resolve: (res: Response) => void = () => {}
  const promise = new Promise<Response>(r => (resolve = r))
  return { promise, resolve }
}

const SETTINGS: SearchSettings = { searchMode: 'balanced', sources: ['web'] }

function setup({
  settings = SETTINGS,
  open = true
}: { settings?: SearchSettings; open?: boolean } = {}) {
  const onSettings = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <OptionsSheet
      open={open}
      onClose={onClose}
      settings={settings}
      onSettings={onSettings}
    />
  )
  return { onSettings, onClose, ...view }
}

const modelRadio = (name: string) =>
  within(screen.getByRole('radiogroup', { name: 'Model' })).getByRole('radio', {
    name
  })

beforeEach(() => {
  vi.clearAllMocks()
  resetModelChoice()
})

describe('OptionsSheet', () => {
  it('renders nothing and loads nothing when closed', () => {
    const fetchImpl = serve({ models: async () => json(DATA) })
    setup({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('closes from the sheet', () => {
    serve({ models: async () => json(DATA) })
    const { onClose } = setup()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  describe('mode', () => {
    it('checks the current mode', () => {
      serve({ models: async () => json(DATA) })
      setup()
      const group = screen.getByRole('radiogroup', { name: 'Search mode' })
      expect(
        within(group).getByRole('radio', { name: 'Balanced' })
      ).toHaveAttribute('aria-checked', 'true')
      expect(
        within(group).getByRole('radio', { name: 'Speed' })
      ).toHaveAttribute('aria-checked', 'false')
    })

    it('switching the mode calls onSettings with the new mode', () => {
      serve({ models: async () => json(DATA) })
      const { onSettings } = setup({
        settings: { searchMode: 'balanced', sources: ['web', 'social'] }
      })
      fireEvent.click(screen.getByRole('radio', { name: 'Quality' }))
      expect(onSettings).toHaveBeenCalledWith({
        searchMode: 'quality',
        sources: ['web', 'social']
      })
    })

    it('does not call onSettings for the mode already chosen', () => {
      serve({ models: async () => json(DATA) })
      const { onSettings } = setup()
      fireEvent.click(screen.getByRole('radio', { name: 'Balanced' }))
      expect(onSettings).not.toHaveBeenCalled()
    })
  })

  describe('sources', () => {
    it('shows each source as a toggle', () => {
      serve({ models: async () => json(DATA) })
      setup({ settings: { searchMode: 'speed', sources: ['academic', 'web'] } })
      expect(screen.getByRole('button', { name: 'Web' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(screen.getByRole('button', { name: 'Academic' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(screen.getByRole('button', { name: 'Social' })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    })

    it('turns a source on, keeping the sources in their usual order', () => {
      serve({ models: async () => json(DATA) })
      const { onSettings } = setup({
        settings: { searchMode: 'speed', sources: ['social'] }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Web' }))
      expect(onSettings).toHaveBeenCalledWith({
        searchMode: 'speed',
        sources: ['web', 'social']
      })
    })

    it('turns a source off', () => {
      serve({ models: async () => json(DATA) })
      const { onSettings } = setup({
        settings: { searchMode: 'speed', sources: ['web', 'academic'] }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Web' }))
      expect(onSettings).toHaveBeenCalledWith({
        searchMode: 'speed',
        sources: ['academic']
      })
    })

    it('the last source left cannot be turned off', () => {
      serve({ models: async () => json(DATA) })
      const { onSettings } = setup()
      const web = screen.getByRole('button', { name: 'Web' })
      expect(web).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(web)
      expect(onSettings).not.toHaveBeenCalled()
      expect(
        screen.getByRole('button', { name: 'Social' })
      ).not.toHaveAttribute('aria-disabled')
    })
  })

  describe('model', () => {
    it('shows the model picker', async () => {
      serve({ models: async () => json(DATA) })
      setup()
      expect(screen.getByText('Loading models…')).toBeInTheDocument()
      expect(
        await screen.findByRole('radiogroup', { name: 'Model' })
      ).toBeInTheDocument()
    })

    it('a failed model list shows a short message and leaves mode and sources usable', async () => {
      serve({ models: async () => json({ error: 'boom' }, 500) })
      const { onSettings } = setup()
      expect(await screen.findByText(MODEL_LOAD_ERROR)).toBeInTheDocument()
      expect(screen.queryByRole('radiogroup', { name: 'Model' })).toBeNull()
      fireEvent.click(screen.getByRole('radio', { name: 'Speed' }))
      expect(onSettings).toHaveBeenCalledWith({
        searchMode: 'speed',
        sources: ['web']
      })
    })

    it('ignores a model list that arrives after the sheet closed', async () => {
      const response = deferred()
      serve({ models: () => response.promise })
      const { rerender, onSettings, onClose } = setup()
      rerender(
        <OptionsSheet
          open={false}
          onClose={onClose}
          settings={SETTINGS}
          onSettings={onSettings}
        />
      )
      await act(async () => response.resolve(json(DATA)))
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('loads the list again each time it opens, clearing an old save error', async () => {
      const fetchImpl = serve({
        models: async () => json(DATA),
        save: async () => json({ error: 'Invalid model' }, 400)
      })
      const { rerender, onSettings, onClose } = setup()
      await screen.findByRole('radiogroup', { name: 'Model' })
      await act(async () => fireEvent.click(modelRadio('Kimi')))
      expect(screen.getByText(MODEL_SAVE_ERROR)).toBeInTheDocument()
      const sheet = (open: boolean) => (
        <OptionsSheet
          open={open}
          onClose={onClose}
          settings={SETTINGS}
          onSettings={onSettings}
        />
      )
      rerender(sheet(false))
      rerender(sheet(true))
      await screen.findByRole('radiogroup', { name: 'Model' })
      expect(screen.queryByText(MODEL_SAVE_ERROR)).toBeNull()
      const loads = fetchImpl.mock.calls.filter(
        ([url]) => String(url) === `${BASE}/api/models`
      )
      expect(loads).toHaveLength(2)
    })
  })
})
