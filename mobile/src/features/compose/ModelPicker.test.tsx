import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Tabs, type TabSpec } from '@/app/Tabs'
import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import { haptic } from '@/core/haptics'
import {
  MODEL_LOAD_ERROR,
  MODEL_SAVE_ERROR,
  ModelPicker
} from '@/features/compose/ModelPicker'
import { resetModelChoice } from '@/features/compose/model-choice'
import type { ModelSelectorData } from '@/lib/types/model-selector'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

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

function setup() {
  return render(<ModelPicker />)
}

const modelRadio = (name: string) =>
  within(screen.getByRole('radiogroup', { name: 'Model' })).getByRole('radio', {
    name
  })

beforeEach(() => {
  vi.clearAllMocks()
  resetModelChoice()
})

describe('ModelPicker', () => {
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
    setup()
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

  it('a failed model list shows a short message', async () => {
    serve({ models: async () => json({ error: 'boom' }, 500) })
    setup()
    expect(await screen.findByText(MODEL_LOAD_ERROR)).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Model' })).toBeNull()
  })

  it('ignores a model list that arrives after it unmounted', async () => {
    const response = deferred()
    serve({ models: () => response.promise })
    const { unmount } = setup()
    unmount()
    await act(async () => response.resolve(json(DATA)))
    expect(screen.queryByRole('radiogroup', { name: 'Model' })).toBeNull()
  })

  it('ignores a failed model list that arrives after it unmounted', async () => {
    const response = deferred()
    serve({ models: () => response.promise })
    const { unmount } = setup()
    unmount()
    await act(async () => response.resolve(json({ error: 'boom' }, 500)))
    expect(screen.queryByText(MODEL_LOAD_ERROR)).toBeNull()
  })

  describe('in a kept tab', () => {
    const TABS: TabSpec[] = [
      { id: 'ask', label: 'Ask', icon: <svg />, render: () => <p>Ask</p> },
      {
        id: 'settings',
        label: 'Settings',
        icon: <svg />,
        render: () => <ModelPicker />
      }
    ]
    const show = (name: string) =>
      act(async () => fireEvent.click(screen.getByRole('tab', { name })))
    const loads = (fetchImpl: ReturnType<typeof serve>) =>
      fetchImpl.mock.calls.filter(
        ([url]) => String(url) === `${BASE}/api/models`
      ).length

    it('loads the list again when its tab is shown again, keeping the old list meanwhile', async () => {
      const models = vi.fn<Route>().mockResolvedValueOnce(json(DATA))
      const fetchImpl = serve({ models })
      render(<Tabs tabs={TABS} initial="settings" />)
      await screen.findByRole('radiogroup', { name: 'Model' })

      // The pick changed elsewhere (the composer's options) meanwhile.
      const reload = deferred()
      models.mockReturnValueOnce(reload.promise)
      await show('Ask')
      expect(loads(fetchImpl)).toBe(1)
      await show('Settings')
      expect(loads(fetchImpl)).toBe(2)
      expect(screen.queryByText('Loading models…')).toBeNull()
      expect(modelRadio('Qwen 3')).toHaveAttribute('aria-checked', 'true')

      await act(async () =>
        reload.resolve(json({ ...DATA, selectedModelKey: 'cloud:kimi' }))
      )
      expect(modelRadio('Kimi')).toHaveAttribute('aria-checked', 'true')
      expect(modelRadio('Qwen 3')).toHaveAttribute('aria-checked', 'false')
    })

    it('a failed reload keeps the list', async () => {
      const models = vi
        .fn<Route>()
        .mockResolvedValueOnce(json(DATA))
        .mockResolvedValueOnce(json({ error: 'boom' }, 500))
      serve({ models })
      render(<Tabs tabs={TABS} initial="settings" />)
      await screen.findByRole('radiogroup', { name: 'Model' })
      await show('Ask')
      await show('Settings')
      expect(screen.queryByText(MODEL_LOAD_ERROR)).toBeNull()
      expect(modelRadio('Qwen 3')).toHaveAttribute('aria-checked', 'true')
    })

    it('a list that failed to load loads again when its tab is shown again', async () => {
      const models = vi
        .fn<Route>()
        .mockResolvedValueOnce(json({ error: 'boom' }, 500))
        .mockResolvedValueOnce(json(DATA))
      serve({ models })
      render(<Tabs tabs={TABS} initial="settings" />)
      expect(await screen.findByText(MODEL_LOAD_ERROR)).toBeInTheDocument()
      await show('Ask')
      await show('Settings')
      expect(screen.queryByText(MODEL_LOAD_ERROR)).toBeNull()
      expect(modelRadio('Qwen 3')).toHaveAttribute('aria-checked', 'true')
    })

    it('a reload that started before a pick does not undo it once saved', async () => {
      const save = deferred()
      const reload = deferred()
      const models = vi
        .fn<Route>()
        .mockResolvedValueOnce(json(DATA))
        .mockReturnValueOnce(reload.promise)
      serve({ models, save: () => save.promise })
      render(<Tabs tabs={TABS} initial="settings" />)
      await screen.findByRole('radiogroup', { name: 'Model' })
      await show('Ask')
      await show('Settings')
      // The old list stays tappable while the reload is on its way.
      await act(async () => fireEvent.click(modelRadio('Kimi')))
      await act(async () =>
        save.resolve(json({ ok: true, selectedModelKey: 'cloud:kimi' }))
      )
      // The reload answers last, with the key from before the save.
      await act(async () => reload.resolve(json(DATA)))
      expect(modelRadio('Kimi')).toHaveAttribute('aria-checked', 'true')
      expect(modelRadio('Qwen 3')).toHaveAttribute('aria-checked', 'false')
    })

    it('a reload while a save is in flight keeps the pick', async () => {
      const save = deferred()
      const models = vi
        .fn<Route>()
        .mockResolvedValueOnce(json(DATA))
        .mockResolvedValueOnce(json(DATA))
      serve({ models, save: () => save.promise })
      render(<Tabs tabs={TABS} initial="settings" />)
      await screen.findByRole('radiogroup', { name: 'Model' })
      await act(async () => fireEvent.click(modelRadio('Kimi')))
      await show('Ask')
      await show('Settings')
      expect(modelRadio('Kimi')).toHaveAttribute('aria-checked', 'true')
      await act(async () =>
        save.resolve(json({ ok: true, selectedModelKey: 'cloud:kimi' }))
      )
      expect(modelRadio('Kimi')).toHaveAttribute('aria-checked', 'true')
    })
  })

  describe('two pickers', () => {
    /** Picker A and picker B, each found by its own container. */
    function renderTwo({ withB = true } = {}) {
      const view = render(
        <>
          <div data-testid="a">
            <ModelPicker />
          </div>
          {withB && (
            <div data-testid="b">
              <ModelPicker />
            </div>
          )}
        </>
      )
      return view
    }
    const radioIn = (picker: string, name: string) =>
      within(screen.getByTestId(picker)).getByRole('radio', { name })
    const checkedIn = (picker: string) =>
      within(screen.getByTestId(picker))
        .getAllByRole('radio')
        .filter(r => r.getAttribute('aria-checked') === 'true')
        .map(r => r.textContent)

    function queuedServer() {
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
      const answer = (index: number, res: Response) =>
        act(async () => answers[index].resolve(res))
      return { sent, answer }
    }

    it('share one queue: a pick in A while B’s save is in flight waits, and both end on the server key', async () => {
      const { sent, answer } = queuedServer()
      renderTwo()
      await act(async () => {})
      await act(async () => fireEvent.click(radioIn('b', 'Kimi')))
      await act(async () => fireEvent.click(radioIn('a', 'Gemma')))
      expect(sent).toEqual([{ providerId: 'cloud', modelId: 'kimi' }])
      expect(checkedIn('a')).toEqual(['Gemma'])
      expect(checkedIn('b')).toEqual(['Gemma'])

      await answer(0, json({ ok: true, selectedModelKey: 'cloud:kimi' }))
      expect(sent).toHaveLength(2)
      await answer(1, json({ error: 'Invalid model' }, 400))
      expect(checkedIn('a')).toEqual(['Kimi'])
      expect(checkedIn('b')).toEqual(['Kimi'])
      for (const picker of ['a', 'b']) {
        expect(
          within(screen.getByTestId(picker)).getByText(MODEL_SAVE_ERROR)
        ).toBeInTheDocument()
      }
    })

    it('a save still in flight from a picker that closed is queued with a pick in another', async () => {
      const { sent, answer } = queuedServer()
      const { rerender } = renderTwo()
      await act(async () => {})
      await act(async () => fireEvent.click(radioIn('b', 'Kimi')))
      // B closes (the options sheet) with its save in flight.
      rerender(
        <div data-testid="a">
          <ModelPicker />
        </div>
      )
      await act(async () => fireEvent.click(radioIn('a', 'Gemma')))
      expect(sent).toHaveLength(1)
      await answer(0, json({ ok: true, selectedModelKey: 'cloud:kimi' }))
      expect(sent.at(-1)).toEqual({ providerId: 'ollama', modelId: 'gemma' })
      await answer(1, json({ ok: true, selectedModelKey: 'ollama:gemma' }))
      expect(checkedIn('a')).toEqual(['Gemma'])
      expect(
        within(screen.getByTestId('a')).queryByText(MODEL_SAVE_ERROR)
      ).toBeNull()
    })
  })
})

describe('ModelPicker haptics', () => {
  it('picking another model ticks selection, once', async () => {
    serve({
      models: async () => json(DATA),
      save: async () => json({ ok: true, selectedModelKey: 'cloud:kimi' })
    })
    setup()
    await screen.findByRole('radiogroup', { name: 'Model' })
    await act(async () => fireEvent.click(modelRadio('Kimi')))
    expect(haptic).toHaveBeenCalledExactlyOnceWith('selection')
  })

  it('a tap on the model already chosen makes none', async () => {
    serve({ models: async () => json(DATA) })
    setup()
    await screen.findByRole('radiogroup', { name: 'Model' })
    fireEvent.click(modelRadio('Qwen 3'))
    expect(haptic).not.toHaveBeenCalled()
  })
})
