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
        spec={specByKey('EMBEDDING_MODEL')!}
        value=""
        onChange={() => {}}
        isSecretSet={false}
      />
    )
    expect(screen.getByText(/embedding model/i)).toBeInTheDocument()
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
})
