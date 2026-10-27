import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { apiGet, confirmDoctorPreparation, getSyntheticCaseHistory, onAuthenticationFailure, previewPayment, subscribeRecordingUpdates } from './api-client.ts'

describe('Web API client errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('binds a payment preview to the selected charge when one visit has multiple laboratory requests', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [],
      data: { allocations: [{ chargeItemId: 'second-charge', amountFen: 800 }], amountFen: 800, channel: 'synthetic-payment',
        chargeItemId: 'second-charge', chargeVersion: 2, commitToken: 'synthetic-token', expectedOutcome: 'success',
        expiresAt: '2026-10-26T12:00:00Z', previewId: 'synthetic-preview' },
    }))
    vi.stubGlobal('fetch', fetch)
    await previewPayment({ caseId: 'same-visit', category: 'laboratory', chargeItemId: 'second-charge', chargeVersion: 2, simulatorRule: 'success' }, 'synthetic-key')
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expectedVersions: { 'ChargeItem/second-charge': '2' },
      input: { caseId: 'same-visit', category: 'laboratory', chargeItemId: 'second-charge', simulatorRule: 'success' },
    })
  })

  it('submits a manual selection from clinical context without depending on a recommendation state', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ auditId: 'synthetic-audit', requestId: 'synthetic-request',
      effects: [], warnings: [], data: { kind: 'diagnosis', draftVersion: 2, encounterVersion: '3', recordIds: ['synthetic-confirmation'] },
    }))
    vi.stubGlobal('fetch', fetch)
    await confirmDoctorPreparation({ caseId: 'synthetic-case', kind: 'diagnosis', encounterId: 'synthetic-encounter', encounterVersion: '2' }, 1,
      [{ kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-fever', role: 'primary' }], 'synthetic-key', true)
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ expectedVersions: { 'Encounter/synthetic-encounter': '2' }, input: {
      expectedDraftVersion: 1, resolveExistingDraft: true,
      selections: [{ kind: 'diagnosis', source: 'manual', catalogItemId: 'diagnosis-fever', role: 'primary' }],
    } })
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ 'idempotency-key': 'synthetic-key' })
  })

  it('omits obsolete proof for manual items but keeps both proof fields for a mixed selection', async () => {
    const fetch = vi.fn(async () => Response.json({ auditId: 'synthetic-audit', requestId: 'synthetic-request',
      effects: [], warnings: [], data: { kind: 'diagnosis', draftVersion: 2, encounterVersion: '3', recordIds: ['synthetic-confirmation'] },
    }))
    vi.stubGlobal('fetch', fetch)
    const context = { caseId: 'synthetic-case', kind: 'diagnosis' as const, encounterId: 'synthetic-encounter', encounterVersion: '2',
      generation: 2, inputFingerprint: 'a'.repeat(64) }
    const manual = { kind: 'diagnosis' as const, source: 'manual' as const, catalogItemId: 'diagnosis-fever', role: 'primary' as const }
    await confirmDoctorPreparation(context, 0, [manual], 'manual-key')
    await confirmDoctorPreparation(context, 0, [manual, { kind: 'diagnosis', source: 'agent', suggestionId: 'current-agent-item',
      catalogItemId: 'diagnosis-hypertension', role: 'secondary' }], 'mixed-key')
    const calls = vi.mocked(globalThis.fetch).mock.calls
    const manualBody = JSON.parse(String(calls[0]?.[1]?.body))
    expect(manualBody.input).not.toHaveProperty('generation')
    expect(manualBody.input).not.toHaveProperty('inputFingerprint')
    expect(JSON.parse(String(calls[1]?.[1]?.body)).input).toMatchObject({ generation: 2, inputFingerprint: 'a'.repeat(64) })
  })

  it('reports notification health for polling fallback and stops reconnecting after disposal', async () => {
    vi.useFakeTimers()
    let disconnect!: () => void
    let activeSignal: AbortSignal | undefined
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ revision: 'a'.repeat(64) }))
      .mockImplementationOnce((_path, input: RequestInit) => new Promise<Response>((_resolve, reject) => {
        activeSignal = input.signal ?? undefined
        disconnect = () => reject(new Error('Synthetic disconnect'))
      }))
      .mockResolvedValueOnce(Response.json({ revision: 'b'.repeat(64) }))
      .mockImplementation((_path, input: RequestInit) => new Promise<Response>((_resolve, reject) => {
        activeSignal = input.signal ?? undefined
        input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true })
      }))
    vi.stubGlobal('fetch', fetch)
    const onChange = vi.fn()
    const health = vi.fn()
    const dispose = subscribeRecordingUpdates('synthetic-case', onChange, health)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(health).toHaveBeenLastCalledWith(true)
      expect(onChange).toHaveBeenCalledTimes(1)
      disconnect()
      await vi.advanceTimersByTimeAsync(0)
      expect(health).toHaveBeenLastCalledWith(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(health).toHaveBeenLastCalledWith(true)
      expect(onChange).toHaveBeenCalledTimes(2)
    } finally { dispose() }
    expect(activeSignal?.aborted).toBe(true)
    const calls = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetch).toHaveBeenCalledTimes(calls)
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

  it('does not deliver a disposed application request to a new authentication listener', async () => {
    let respond: (response: Response) => void = () => undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve })))
    const oldHandler = vi.fn()
    const release = onAuthenticationFailure(oldHandler)
    const request = apiGet('/api/his/v1/registrations', z.unknown())
    release()
    const nextHandler = vi.fn()
    const releaseNext = onAuthenticationFailure(nextHandler)
    try {
      respond(new Response(null, { status: 401 }))
      await expect(request).rejects.toMatchObject({ status: 401 })
      expect(oldHandler).not.toHaveBeenCalled()
      expect(nextHandler).not.toHaveBeenCalled()
    } finally {
      releaseNext()
    }
  })

  it.each(['/api/auth/sign-in/email', '/api/auth/context', '/clinmesh-agent-proof'])(
    'leaves authentication failures from %s to their owner', async path => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
      const handler = vi.fn()
      const release = onAuthenticationFailure(handler)
      try {
        await expect(apiGet(path, z.unknown())).rejects.toMatchObject({ status: 401 })
        expect(handler).not.toHaveBeenCalled()
      } finally {
        release()
      }
    },
  )

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

  it('preserves response diagnostics when source history contains an invalid date', async () => {
    const correlationId = '01991234-7abc-7def-8abc-0123456789ab'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      items: [{
        businessDate: '2025-01-10',
        items: [{
          clinicalDate: 'invalid',
          resourceType: 'Condition',
          sourceReference: 'urn:uuid:prior-condition',
          title: '合成病史',
        }],
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    }, { headers: { 'X-Correlation-Id': correlationId } })))

    await expect(getSyntheticCaseHistory('synthetic-case-001')).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      correlationId,
      status: 200,
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
