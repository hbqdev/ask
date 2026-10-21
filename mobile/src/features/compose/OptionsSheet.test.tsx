import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import {
  MODEL_LOAD_ERROR,
  MODEL_SAVE_ERROR,
  OptionsSheet
} from '@/features/compose/OptionsSheet'
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
    it('shows a loading line, then the models grouped by provider with the selected one checked', async () => {
      const response = deferred()
      serve({ models: () => response.promise })
      setup()
      expect(screen.getByText('Loading models…')).toBeInTheDocument()
      await act(async () => response.resolve(json(DATA)))
      expect(screen.queryByText('Loading models…')).toBeNull()

      const group = screen.getByRole('radiogroup', { name: 'Model' })
      const headings = within(group)
        .getAllByRole('heading')
        .map(h => h.textContent)
      expect(headings).toEqual(['Cloud', 'Ollama'])
      expect(modelRadio('Qwen 3')).toHaveAttribute('aria-checked', 'true')
      expect(modelRadio('Gemma')).toHaveAttribute('aria-checked', 'false')
      expect(modelRadio('Kimi')).toHaveAttribute('aria-checked', 'false')
    })

    it('tapping a model saves it with a PUT and checks it', async () => {
      const fetchImpl = serve({
        models: async () => json(DATA),
        save: async () => json({ ok: true, selectedModelKey: 'cloud:kimi' })
      })
      const { onSettings } = setup()
      await screen.findByRole('radiogroup', { name: 'Model' })
      await act(async () => fireEvent.click(modelRadio('Kimi')))

      const put = fetchImpl.mock.calls.find(
        ([url]) => String(url) === `${BASE}/api/settings/model`
      )
      expect(put?.[1]?.method).toBe('PUT')
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        providerId: 'cloud',
        modelId: 'kimi'
      })
      expect(modelRadio('Kimi')).toHaveAttribute('aria-checked', 'true')
      expect(modelRadio('Qwen 3')).toHaveAttribute('aria-checked', 'false')
      expect(onSettings).not.toHaveBeenCalled()
    })

    it('checks the tapped model at once, before the save answers', async () => {
      const save = deferred()
      serve({ models: async () => json(DATA), save: () => save.promise })
      setup()
      await screen.findByRole('radiogroup', { name: 'Model' })
      fireEvent.click(modelRadio('Gemma'))
      expect(modelRadio('Gemma')).toHaveAttribute('aria-checked', 'true')
      await act(async () =>
        save.resolve(json({ ok: true, selectedModelKey: 'ollama:gemma' }))
      )
      expect(modelRadio('Gemma')).toHaveAttribute('aria-checked', 'true')
    })

    it('a failed save shows the error and puts the check back', async () => {
      serve({
        models: async () => json(DATA),
        save: async () => json({ error: 'Invalid model' }, 400)
      })
      setup()
      await screen.findByRole('radiogroup', { name: 'Model' })
      await act(async () => fireEvent.click(modelRadio('Kimi')))
      expect(screen.getByText(MODEL_SAVE_ERROR)).toBeInTheDocument()
      expect(modelRadio('Qwen 3')).toHaveAttribute('aria-checked', 'true')
      expect(modelRadio('Kimi')).toHaveAttribute('aria-checked', 'false')
    })

    it('clears the error on the next successful pick', async () => {
      const save = vi
        .fn<Route>()
        .mockResolvedValueOnce(json({ error: 'Invalid model' }, 400))
        .mockResolvedValueOnce(
          json({ ok: true, selectedModelKey: 'ollama:gemma' })
        )
      serve({ models: async () => json(DATA), save })
      setup()
      await screen.findByRole('radiogroup', { name: 'Model' })
      await act(async () => fireEvent.click(modelRadio('Kimi')))
      expect(screen.getByText(MODEL_SAVE_ERROR)).toBeInTheDocument()
      await act(async () => fireEvent.click(modelRadio('Gemma')))
      expect(screen.queryByText(MODEL_SAVE_ERROR)).toBeNull()
      expect(modelRadio('Gemma')).toHaveAttribute('aria-checked', 'true')
    })

    it('ignores a tap on the model already chosen', async () => {
      const fetchImpl = serve({ models: async () => json(DATA) })
      setup()
      await screen.findByRole('radiogroup', { name: 'Model' })
      fireEvent.click(modelRadio('Qwen 3'))
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    describe('rapid picks', () => {
      const OK = (key: string) => json({ ok: true, selectedModelKey: key })
      const FAIL = () => json({ error: 'Invalid model' }, 400)

      /** Each PUT waits for the test to answer it, in the order sent. */
      async function rapid() {
        const answers: ReturnType<typeof deferred>[] = []
        const sent: unknown[] = []
        serve({
          models: async () => json(DATA),
          save: init => {
            sent.push(JSON.parse(String(init?.body)))
            const answer = deferred()
            answers.push(answer)
            return answer.promise
          }
        })
        setup()
        await screen.findByRole('radiogroup', { name: 'Model' })
        const answer = async (index: number, res: Response) =>
          act(async () => answers[index].resolve(res))
        return { sent, answer }
      }

      /** A tap, then a flush, so any save it starts reaches the server. */
      const tap = (name: string) =>
        act(async () => fireEvent.click(modelRadio(name)))

      const checked = () =>
        within(screen.getByRole('radiogroup', { name: 'Model' }))
          .getAllByRole('radio')
          .filter(r => r.getAttribute('aria-checked') === 'true')
          .map(r => r.textContent)

      it('sends one save at a time, then the newest pick, and checks it when both save', async () => {
        const { sent, answer } = await rapid()
        await tap('Kimi')
        await tap('Gemma')
        expect(sent).toEqual([{ providerId: 'cloud', modelId: 'kimi' }])
        expect(checked()).toEqual(['Gemma'])
        await answer(0, OK('cloud:kimi'))
        expect(checked()).toEqual(['Gemma'])
        expect(sent).toHaveLength(2)
        await answer(1, OK('ollama:gemma'))
        expect(sent.at(-1)).toEqual({ providerId: 'ollama', modelId: 'gemma' })
        expect(checked()).toEqual(['Gemma'])
        expect(screen.queryByText(MODEL_SAVE_ERROR)).toBeNull()
      })

      it('skips picks overtaken while a save is in flight', async () => {
        const { sent, answer } = await rapid()
        await tap('Kimi')
        await tap('Gemma')
        await tap('Qwen 3')
        await answer(0, OK('cloud:kimi'))
        await answer(1, OK('ollama:qwen3'))
        expect(sent).toEqual([
          { providerId: 'cloud', modelId: 'kimi' },
          { providerId: 'ollama', modelId: 'qwen3' }
        ])
        expect(checked()).toEqual(['Qwen 3'])
      })

      it('the reviewer case: A still saving when B is tapped, A saves late, B fails: the checked model is the server key (A) and the error shows', async () => {
        const { sent, answer } = await rapid()
        await tap('Kimi')
        await tap('Gemma')
        // B cannot fail before A settles: it is not sent until then.
        expect(sent).toHaveLength(1)
        await answer(0, OK('cloud:kimi'))
        await answer(1, FAIL())
        expect(checked()).toEqual(['Kimi'])
        expect(screen.getByText(MODEL_SAVE_ERROR)).toBeInTheDocument()
      })

      it('an earlier pick that fails does not undo a later one that saves', async () => {
        const { answer } = await rapid()
        await tap('Kimi')
        await tap('Gemma')
        await answer(0, FAIL())
        expect(checked()).toEqual(['Gemma'])
        await answer(1, OK('ollama:gemma'))
        expect(checked()).toEqual(['Gemma'])
        expect(screen.queryByText(MODEL_SAVE_ERROR)).toBeNull()
      })

      it('both failing puts back the model the server still holds', async () => {
        const { answer } = await rapid()
        await tap('Kimi')
        await tap('Gemma')
        await answer(0, FAIL())
        await answer(1, FAIL())
        expect(checked()).toEqual(['Qwen 3'])
        expect(screen.getByText(MODEL_SAVE_ERROR)).toBeInTheDocument()
      })

      it('sends nothing more when the newest pick is what the server already holds', async () => {
        const { sent, answer } = await rapid()
        await tap('Kimi')
        await tap('Qwen 3')
        await answer(0, FAIL())
        expect(sent).toHaveLength(1)
        expect(checked()).toEqual(['Qwen 3'])
        expect(screen.queryByText(MODEL_SAVE_ERROR)).toBeNull()
      })
    })

    it.each([
      ['model selection is off', { ...DATA, enabled: false }],
      [
        'no model is available',
        { ...DATA, hasAvailableModels: false, modelsByProvider: {} }
      ]
    ])('hides the model section when %s', async (_name, data) => {
      serve({ models: async () => json(data) })
      setup()
      await act(async () => {})
      expect(screen.queryByText('Loading models…')).toBeNull()
      expect(screen.queryByRole('radiogroup', { name: 'Model' })).toBeNull()
      expect(screen.queryByText('Model')).toBeNull()
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
