import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { ModelSelectorData } from '@/lib/types/model-selector'

import { ModelSelectorClient } from '../model-selector-client'

const saveModelPreference = vi.fn((..._args: unknown[]) => Promise.resolve())
vi.mock('@/lib/actions/model-preference', () => ({
  saveModelPreference: (...args: unknown[]) => saveModelPreference(...args)
}))

const data = {
  enabled: true,
  hasAvailableModels: true,
  modelsByProvider: {
    Ollama: [
      {
        id: 'a:cloud',
        name: 'a:cloud',
        provider: 'Ollama',
        providerId: 'ollama'
      },
      {
        id: 'b:cloud',
        name: 'b:cloud',
        provider: 'Ollama',
        providerId: 'ollama'
      }
    ]
  },
  selectedModelKey: 'ollama:a:cloud'
} as unknown as ModelSelectorData

describe('ModelSelectorClient', () => {
  beforeEach(() => saveModelPreference.mockClear())

  test('shows the server pick when uncontrolled', () => {
    render(<ModelSelectorClient data={data} />)
    expect(screen.getByRole('combobox').getAttribute('aria-label')).toBe(
      'Model: a:cloud'
    )
  })

  test('shows the controlled pick over the server pick', () => {
    render(
      <ModelSelectorClient data={data} selectedModelKey="ollama:b:cloud" />
    )
    expect(screen.getByRole('combobox').getAttribute('aria-label')).toBe(
      'Model: b:cloud'
    )
  })

  test('a pick is reported to the owner and saved on the account', () => {
    const onChange = vi.fn()
    render(
      <ModelSelectorClient
        data={data}
        selectedModelKey="ollama:a:cloud"
        onSelectedModelKeyChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('button', { name: /b:cloud/ }))
    expect(onChange).toHaveBeenCalledWith('ollama:b:cloud')
    expect(saveModelPreference).toHaveBeenCalledWith('ollama', 'b:cloud')
  })
})
