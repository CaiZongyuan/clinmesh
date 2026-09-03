import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { apiGet } from './api-client.ts'

describe('Web API client errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('normalizes a non-JSON response without exposing its body', async () => {
    const correlationId = '01991234-7abc-7def-8abc-0123456789ab'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'private gateway failure detail',
      {
        headers: { 'X-Correlation-Id': correlationId },
        status: 500,
      },
    )))

    const request = apiGet('/api/runtime-failure', z.object({ ok: z.literal(true) }))

    await expect(request).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      correlationId,
      message: 'ClinMesh returned an unreadable response',
      name: 'ApiClientError',
      status: 500,
    })
  })

  it('normalizes a successful response that violates its schema', async () => {
    const correlationId = '01991234-7abc-7def-8abc-0123456789ab'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(
      { privateField: 'must not appear in the client error' },
      { headers: { 'X-Correlation-Id': correlationId } },
    )))

    await expect(apiGet('/api/invalid-contract', z.object({ ok: z.literal(true) })))
      .rejects.toMatchObject({
        code: 'UNEXPECTED_RESPONSE',
        correlationId,
        message: 'ClinMesh returned a response that does not match the expected contract',
        name: 'ApiClientError',
        status: 200,
      })
  })

  it('normalizes a network failure without exposing the transport error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private socket failure detail')))

    const request = apiGet('/api/unavailable', z.object({ ok: z.literal(true) }))

    await expect(request).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      correlationId: undefined,
      message: 'ClinMesh could not be reached',
      name: 'ApiClientError',
      status: 0,
    })
  })

  it('aborts a request after the thirty second deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => new Promise<Response>((
      _resolve,
      reject,
    ) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })))

    const request = apiGet('/api/slow', z.object({ ok: z.literal(true) }))
    const assertion = expect(request).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      message: 'The ClinMesh request timed out',
      name: 'ApiClientError',
      status: 0,
    })
    await vi.advanceTimersByTimeAsync(30_000)

    await assertion
  })

  it('keeps caller cancellation distinct from timeout and network failures', async () => {
    const caller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => new Promise<Response>((
      _resolve,
      reject,
    ) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })))

    const request = apiGet('/api/cancelled', z.object({ ok: z.literal(true) }), caller.signal)
    caller.abort()

    await expect(request).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
      message: 'The ClinMesh request was cancelled',
      name: 'ApiClientError',
      status: 0,
    })
  })

  it('keeps the deadline active while reading the response body', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => Promise.resolve(new Response(
      new ReadableStream({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          })
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ))))

    const request = apiGet('/api/slow-body', z.object({ ok: z.literal(true) }))
    const assertion = expect(request).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      name: 'ApiClientError',
      status: 0,
    })
    await vi.advanceTimersByTimeAsync(30_000)

    await assertion
  })
})
