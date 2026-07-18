import { describe, expect, it } from 'vitest'
import { addItem, move, parseList, removeAt, serializeList } from '../model-list'

describe('model-list codec', () => {
  it('parses comma lists, trimming and dropping empties', () => {
    expect(parseList('a:cloud,  b:cloud , ')).toEqual(['a:cloud', 'b:cloud'])
    expect(parseList('')).toEqual([])
  })
  it('serializes with ", " separator', () => {
    expect(serializeList(['a', 'b'])).toBe('a, b')
  })
  it('adds, removes, and moves', () => {
    expect(addItem(['a'], 'b')).toEqual(['a', 'b'])
    expect(removeAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
    expect(move(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })
  it('addItem ignores blank/duplicate', () => {
    expect(addItem(['a'], '  ')).toEqual(['a'])
    expect(addItem(['a'], 'a')).toEqual(['a'])
  })
})
