import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' })
}))

import WildBreathField from '@/components/ui/wild-breath-field'

describe('WildBreathField', () => {
  it('renders a canvas and accepts an intensity prop without throwing', () => {
    const a = render(<WildBreathField />)
    expect(a.container.querySelector('canvas')).not.toBeNull()
    const b = render(<WildBreathField intensity={1} className="x" />)
    expect(b.container.querySelector('canvas')).not.toBeNull()
  })
})
