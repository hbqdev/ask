import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import { installIntersectionObserver } from '@/test/intersection-observer'
import { installResizeObserver } from '@/test/resize-observer'

installResizeObserver()
installIntersectionObserver()

afterEach(() => {
  cleanup()
})
