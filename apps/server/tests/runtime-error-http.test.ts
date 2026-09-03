import { apiErrorSchema } from '@clinmesh/contracts/his'
import { operationOutcomeSchema } from '@clinmesh/contracts/fhir'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.ts'
import { IdentityError, type IdentityService } from '../src/application/identity-service.ts'
import type { FhirRepository } from '../src/infrastructure/sqlite/fhir-repository.ts'

function failingIdentity(message: string): IdentityService {
  return {
    resolveSessionContext() {
      throw new Error(message)
    },
  } as unknown as IdentityService
}

describe('runtime HTTP errors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('generates a trusted correlation ID for a successful request', async () => {
    const supplied = '01991234-7abc-7def-8abc-0123456789ab'
    const response = await createApp().request('/api/health', {
      headers: { 'X-Correlation-Id': supplied },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(response.headers.get('x-correlation-id')).not.toBe(supplied)
  })

  it('returns and logs a correlated, redacted JSON error for an unexpected HIS failure', async () => {
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await createApp({
      identity: failingIdentity('patient secret must not leave the failure boundary'),
    }).request('/api/auth/context')

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/json')
    const correlationId = response.headers.get('x-correlation-id')
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(apiErrorSchema.parse(await response.json())).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        correlationId,
        message: 'The ClinMesh request could not be completed',
      },
    })

    expect(errorOutput).toHaveBeenCalledOnce()
    const report = JSON.parse(String(errorOutput.mock.calls[0]?.[0])) as unknown
    expect(report).toMatchObject({
      correlationId,
      error: { name: 'Error' },
      event: 'runtime.error',
      method: 'GET',
      route: '/api/auth/context',
      scope: 'http',
    })
    expect(JSON.stringify(report)).not.toContain('patient secret')
  })

  it('does not log an untrusted error name or injected stack line', async () => {
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failure = new Error('credential-secret\nat clinical-body-secret')
    let nameReads = 0
    Object.defineProperty(failure, 'name', {
      get() {
        nameReads += 1
        return nameReads === 1 ? 'Error' : 'credential-secret'
      },
    })
    const identity = {
      resolveSessionContext() {
        throw failure
      },
    } as unknown as IdentityService

    await createApp({ identity }).request('/api/auth/context')

    const report = JSON.parse(String(errorOutput.mock.calls[0]?.[0])) as unknown
    expect(report).toMatchObject({ error: { name: 'Error' } })
    expect(nameReads).toBe(1)
    expect(JSON.stringify(report)).not.toContain('credential-secret')
    expect(JSON.stringify(report)).not.toContain('clinical-body-secret')
  })

  it('keeps the structured failure response when reading the error name throws', async () => {
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failure = new Error('private failure')
    Object.defineProperty(failure, 'name', {
      get() {
        throw new Error('credential-secret')
      },
    })
    const identity = {
      resolveSessionContext() {
        throw failure
      },
    } as unknown as IdentityService

    const response = await createApp({ identity }).request('/api/auth/context')

    expect(response.status).toBe(500)
    expect(apiErrorSchema.parse(await response.json())).toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    })
    const report = JSON.parse(String(errorOutput.mock.calls[0]?.[0])) as unknown
    expect(report).toMatchObject({ error: { name: 'UnknownError' } })
    expect(JSON.stringify(report)).not.toContain('credential-secret')
  })

  it('returns a correlated FHIR OperationOutcome for an unexpected FHIR failure', async () => {
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await createApp({
      fhir: {
        repository: {} as FhirRepository,
        resolveContext() {
          throw new Error('FHIR internal detail must remain private')
        },
      },
    }).request('/fhir/R5/Patient/private-patient-reference')

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/fhir+json')
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(operationOutcomeSchema.parse(await response.json())).toMatchObject({
      issue: [{
        code: 'exception',
        diagnostics: 'The FHIR request could not be completed',
        severity: 'error',
      }],
      resourceType: 'OperationOutcome',
    })
    const report = JSON.parse(String(errorOutput.mock.calls[0]?.[0])) as unknown
    expect(report).toMatchObject({ route: '/fhir/R5/:resourceType/:resourceId' })
    expect(JSON.stringify(report)).not.toContain('private-patient-reference')
  })

  it('adds the response correlation ID to a known HIS error without logging it as unexpected', async () => {
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const identity = {
      resolveSessionContext() {
        throw new IdentityError('AUTHENTICATION_REQUIRED', 'A valid session is required')
      },
    } as unknown as IdentityService
    const response = await createApp({ identity }).request('/api/auth/context')

    const correlationId = response.headers.get('x-correlation-id')
    expect(response.status).toBe(401)
    expect(apiErrorSchema.parse(await response.json())).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        correlationId,
        message: 'A valid session is required',
      },
    })
    expect(errorOutput).not.toHaveBeenCalled()
  })
})
