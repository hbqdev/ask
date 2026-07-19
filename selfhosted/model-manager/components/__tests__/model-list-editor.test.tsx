import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelListEditor } from '../model-list-editor'

describe('ModelListEditor', () => {
  it('adds a model', () => {
    const onChange = vi.fn()
    render(<ModelListEditor value="a:cloud" onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText(/add model/i), {
      target: { value: 'b:cloud' }
    })
    fireEvent.click(screen.getByRole('button', { name: /add/i }))
    expect(onChange).toHaveBeenCalledWith('a:cloud, b:cloud')
  })
  it('removes a model', () => {
    const onChange = vi.fn()
    render(<ModelListEditor value="a:cloud, b:cloud" onChange={onChange} />)
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0])
    expect(onChange).toHaveBeenCalledWith('b:cloud')
  })
  it('moves a model up', () => {
    const onChange = vi.fn()
    render(<ModelListEditor value="a, b" onChange={onChange} />)
    fireEvent.click(screen.getAllByRole('button', { name: /move up/i })[0]) // on 'b'
    expect(onChange).toHaveBeenCalledWith('b, a')
  })
})
