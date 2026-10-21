import { describe, expect, it } from 'vitest'

import { ApiError, toApiError } from '@/core/api/errors'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' }
  })
}

describe('ApiError', () => {
  it('is an Error carrying the status, retryable flag and code', () => {
    const err = new ApiError(429, 'Slow down', {
      retryable: false,
      code: 'rate_limit'
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ApiError')
    expect(err.message).toBe('Slow down')
    expect(err.status).toBe(429)
    expect(err.retryable).toBe(false)
    expect(err.code).toBe('rate_limit')
  })

  it.each([0, 429, 502, 503, 504])(
    'defaults retryable to true for status %i',
    status => {
      expect(new ApiError(status, 'x').retryable).toBe(true)
    }
  )

  it.each([400, 401, 403, 404, 500])(
    'defaults retryable to false for status %i',
    status => {
      expect(new ApiError(status, 'x').retryable).toBe(false)
    }
  )

  it('leaves code undefined when none is given', () => {
    expect(new ApiError(400, 'x').code).toBeUndefined()
  })
})

describe('toApiError', () => {
  it('reads the message from a JSON {error} body', async () => {
    const err = await toApiError(
      jsonResponse({ error: 'Authentication required' }, 401)
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.message).toBe('Authentication required')
    expect(err.retryable).toBe(false)
    expect(err.code).toBeUndefined()
  })

  it("parses Ask's public error JSON, keeping its code and retryable flag", async () => {
    const err = await toApiError(
      jsonResponse(
        {
          code: 'timeout',
          type: 'general',
          error:
            'The response took too long and was stopped. Please try again.',
          retryable: true
        },
        500
      )
    )
    expect(err.status).toBe(500)
    expect(err.code).toBe('timeout')
    expect(err.retryable).toBe(true)
    expect(err.message).toBe(
      'The response took too long and was stopped. Please try again.'
    )
  })

  it('lets an explicit retryable:false in the body override the status default', async () => {
    const err = await toApiError(
      jsonResponse(
        {
          code: 'rate_limit',
          type: 'rate-limit',
          error: 'Daily limit reached.',
          retryable: false
        },
        429
      )
    )
    expect(err.retryable).toBe(false)
    expect(err.code).toBe('rate_limit')
  })

  it('parses a plain-text 503 body as a retryable error', async () => {
    const err = await toApiError(
      textResponse('No enabled model is available', 503)
    )
    expect(err.status).toBe(503)
    expect(err.message).toBe('No enabled model is available')
    expect(err.retryable).toBe(true)
    expect(err.code).toBeUndefined()
  })

  it('trims surrounding whitespace from a plain-text body', async () => {
    const err = await toApiError(textResponse('  Bad request\n', 400))
    expect(err.message).toBe('Bad request')
  })

  it('falls back to a generic message for an empty body', async () => {
    const err = await toApiError(new Response(null, { status: 502 }))
    expect(err.status).toBe(502)
    expect(err.message).toBe('Request failed (502)')
    expect(err.retryable).toBe(true)
  })

  it('does not surface an HTML error page as the message', async () => {
    const err = await toApiError(
      new Response('<!DOCTYPE html><html><body>Bad gateway</body></html>', {
        status: 504,
        headers: { 'Content-Type': 'text/html' }
      })
    )
    expect(err.message).toBe('Request failed (504)')
    expect(err.retryable).toBe(true)
  })

  it('falls back when JSON has no usable error string', async () => {
    const err = await toApiError(jsonResponse({ error: { nested: 1 } }, 400))
    expect(err.message).toBe('Request failed (400)')
  })

  it('ignores a non-string code and a non-boolean retryable', async () => {
    const err = await toApiError(
      jsonResponse({ error: 'Nope', code: 42, retryable: 'yes' }, 429)
    )
    expect(err.message).toBe('Nope')
    expect(err.code).toBeUndefined()
    expect(err.retryable).toBe(true)
  })

  it('treats a JSON non-object body as plain text', async () => {
    const err = await toApiError(textResponse('"Gone"', 410))
    expect(err.message).toBe('"Gone"')
  })

  it('falls back when the body cannot be read', async () => {
    const res = new Response('already read', { status: 500 })
    await res.text()
    const err = await toApiError(res)
    expect(err.status).toBe(500)
    expect(err.message).toBe('Request failed (500)')
  })
})
