import { describe, expect, test } from 'vitest'

import { rotateWindow } from './rotate-window'

const P = ['a', 'b', 'c', 'd', 'e']

describe('rotateWindow', () => {
  test('slides a window of `count` from `start`', () => {
    expect(rotateWindow(P, 0, 3)).toEqual(['a', 'b', 'c'])
    expect(rotateWindow(P, 1, 3)).toEqual(['b', 'c', 'd'])
    expect(rotateWindow(P, 0, 1)).toEqual(['a'])
    expect(rotateWindow(P, 2, 1)).toEqual(['c'])
  })

  test('wraps around the end of the pool', () => {
    expect(rotateWindow(P, 3, 3)).toEqual(['d', 'e', 'a'])
    expect(rotateWindow(P, 4, 1)).toEqual(['e'])
    // a running counter beyond length keeps wrapping
    expect(rotateWindow(P, 5, 1)).toEqual(['a'])
    expect(rotateWindow(P, 6, 2)).toEqual(['b', 'c'])
  })

  test('clamps count to pool length (no duplicates within a window)', () => {
    expect(rotateWindow(['x', 'y'], 0, 3)).toEqual(['x', 'y'])
    expect(rotateWindow(['only'], 0, 3)).toEqual(['only'])
  })

  test('edge cases: empty pool, non-positive count, negative start', () => {
    expect(rotateWindow([], 0, 3)).toEqual([])
    expect(rotateWindow(P, 0, 0)).toEqual([])
    expect(rotateWindow(P, -1, 2)).toEqual(['e', 'a'])
  })
})
