import { describe, expect, it } from 'vitest'

import {
  type ChatErrorView,
  describeChatError
} from '@/features/thread/model/chat-errors'
import { toPublicErrorPayload } from '@/lib/errors/public-error'

const view = (message: string) => describeChatError(new Error(message))

describe('describeChatError', () => {
  it('reads a JSON public error payload', () => {
    expect(
      view(
        '{"error":"Rate limited","code":"rate_limit","type":"rate-limit","retryable":false}'
      )
    ).toEqual<ChatErrorView>({
      message: 'Rate limited',
      retryable: false,
      authRequired: false
    })
  })

  it('reads authRequired from a JSON 401 body', () => {
    expect(
      view('{"error":"Please sign in","mode":"quality","authRequired":true}')
    ).toEqual<ChatErrorView>({
      message: 'Please sign in',
      retryable: false,
      authRequired: true
    })
  })

  it('shows the public message for a JSON body with no top-level error text', () => {
    const raw = '{"error":{"message":"upstream 502 from 10.0.0.5"}}'
    expect(view(raw)).toEqual<ChatErrorView>({
      message: toPublicErrorPayload(raw).error,
      retryable: true,
      authRequired: false
    })
    expect(view(raw).message).not.toContain('10.0.0.5')
  })

  it('treats "Authentication required" as sign-in, not retryable', () => {
    expect(view('Authentication required')).toEqual<ChatErrorView>({
      message: 'Authentication required',
      retryable: false,
      authRequired: true
    })
  })

  it('treats "Signed out" as sign-in, not retryable', () => {
    expect(view('Signed out')).toEqual<ChatErrorView>({
      message: 'Signed out',
      retryable: false,
      authRequired: true
    })
  })

  it('never offers Retry on an auth payload, even one marked retryable', () => {
    expect(
      view('{"error":"Please sign in","authRequired":true,"retryable":true}')
    ).toEqual<ChatErrorView>({
      message: 'Please sign in',
      retryable: false,
      authRequired: true
    })
  })

  it('treats a JSON "Authentication required" body as sign-in', () => {
    expect(view('{"error":"Authentication required"}')).toEqual<ChatErrorView>({
      message: 'Authentication required',
      retryable: false,
      authRequired: true
    })
  })

  it('treats an auth_required code as sign-in, not retryable', () => {
    expect(
      view('{"error":"Sign in","code":"auth_required","retryable":true}')
    ).toEqual<ChatErrorView>({
      message: 'Sign in',
      retryable: false,
      authRequired: true
    })
  })

  it('uses a plain-text body as it is, retryable by default', () => {
    expect(view('No enabled model is available')).toEqual<ChatErrorView>({
      message: 'No enabled model is available',
      retryable: true,
      authRequired: false
    })
  })

  it('treats JSON that is not an object as plain text', () => {
    expect(view('42').message).toBe('42')
  })

  it('says "Something went wrong" for an empty message', () => {
    expect(view('')).toEqual<ChatErrorView>({
      message: 'Something went wrong',
      retryable: true,
      authRequired: false
    })
  })
})
