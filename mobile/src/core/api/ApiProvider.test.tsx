import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider, useApi } from '@/core/api/ApiProvider'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'

vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))

const getAccessToken = vi.fn(async () => 'fake-token')

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ApiProvider baseUrl="https://ask.test.invalid">{children}</ApiProvider>
  )
}

describe('ApiProvider', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({ getAccessToken } as unknown as Auth)
  })

  it('useApi throws outside the provider', () => {
    // React logs the thrown render error; keep the output clean.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useApi())).toThrow(
      'useApi must be used inside ApiProvider'
    )
    consoleError.mockRestore()
  })

  it('gives a client on the base URL and the auth token getter', async () => {
    const { result } = renderHook(() => useApi(), { wrapper })

    expect(result.current.baseUrl).toBe('https://ask.test.invalid')
    expect(result.current.client.url('/x')).toBe('https://ask.test.invalid/x')
    await expect(result.current.getToken()).resolves.toBe('fake-token')
  })

  it('keeps one client across renders', () => {
    const { result, rerender } = renderHook(() => useApi(), { wrapper })
    const first = result.current.client
    rerender()
    expect(result.current.client).toBe(first)
  })
})
