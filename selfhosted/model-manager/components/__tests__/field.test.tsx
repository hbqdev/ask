import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Field } from '../field'
import { specByKey } from '@/lib/env-schema'

describe('Field', () => {
  it('renders a url input and reports changes', () => {
    const onChange = vi.fn()
    render(
      <Field
        spec={specByKey('OLLAMA_BASE_URL')!}
        value="http://a"
        onChange={onChange}
        isSecretSet={false}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'http://b' }
    })
    expect(onChange).toHaveBeenCalledWith('http://b')
  })
  it('shows a validation error for bad url', () => {
    render(
      <Field
        spec={specByKey('OLLAMA_BASE_URL')!}
        value="nope"
        onChange={() => {}}
        isSecretSet={false}
      />
    )
    expect(screen.getByText(/must be an http/i)).toBeInTheDocument()
  })
  it('renders an enum as a listbox with the allowed options', () => {
    render(
      <Field
        spec={specByKey('SEARCH_API')!}
        value=""
        onChange={() => {}}
        isSecretSet={false}
      />
    )
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })
  it('renders EMBEDDING_MODEL read-only with its explanation, not a dropdown', () => {
    const onChange = vi.fn()
    render(
      <Field
        spec={specByKey('EMBEDDING_MODEL')!}
        value="Qwen/Qwen3-Embedding-0.6B"
        onChange={onChange}
        isSecretSet={false}
      />
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('Qwen/Qwen3-Embedding-0.6B')
    expect(screen.getByText(/silently corrupts memory/i)).toBeInTheDocument()
  })
  it('masks a secret that is set', () => {
    render(
      <Field
        spec={specByKey('RERANKER_API_TOKEN')!}
        value=""
        onChange={() => {}}
        isSecretSet
      />
    )
    expect(screen.getByPlaceholderText(/unchanged/i)).toBeInTheDocument()
  })
  it('offers Clear for a set optional secret and reports it', () => {
    const onClear = vi.fn()
    render(
      <Field
        spec={specByKey('RERANKER_API_TOKEN')!}
        value=""
        onChange={() => {}}
        isSecretSet
        onClear={onClear}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /clear this secret/i }))
    expect(onClear).toHaveBeenCalledWith(true)
  })
  it('shows the pending clear with an Undo', () => {
    const onClear = vi.fn()
    render(
      <Field
        spec={specByKey('RERANKER_API_TOKEN')!}
        value=""
        onChange={() => {}}
        isSecretSet
        cleared
        onClear={onClear}
      />
    )
    expect(screen.getByText(/will be cleared on apply/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /undo/i }))
    expect(onClear).toHaveBeenCalledWith(false)
  })
  it('no Clear for an unset secret or a required one', () => {
    const spec = specByKey('RERANKER_API_TOKEN')!
    const { unmount } = render(
      <Field
        spec={spec}
        value=""
        onChange={() => {}}
        isSecretSet={false}
        onClear={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull()
    unmount()
    render(
      <Field
        spec={{ ...spec, required: true }}
        value=""
        onChange={() => {}}
        isSecretSet
        onClear={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull()
  })
})
