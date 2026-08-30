import { describe, expect, it, vi } from 'vitest'
import { createHttpExecutor } from '../src/http-executor.ts'

describe('HIS HTTP operation executor', () => {
  it('encodes a Catalog query and validates the response for a human session', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      items: [],
      page: 2,
      pageSize: 20,
      releaseId: 'reference-release-current',
      total: 0,
    }))
    const execute = createHttpExecutor({
      baseUrl: 'http://127.0.0.1:51868',
      credential: { cookie: 'better-auth.session_token=synthetic', kind: 'human' },
      fetch,
    })

    await expect(execute('reference.diagnoses.search', {
      page: 2,
      pageSize: 20,
      query: '糖尿病',
    })).resolves.toMatchObject({ page: 2, total: 0 })

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(
      'http://127.0.0.1:51868/api/his/v1/reference-catalogs/diagnoses?page=2&pageSize=20&query=%E7%B3%96%E5%B0%BF%E7%97%85',
    )
    expect(init).toMatchObject({
      headers: {
        accept: 'application/json',
        cookie: 'better-auth.session_token=synthetic',
      },
      method: 'GET',
    })
    expect(init.body).toBeUndefined()
  })

  it('encodes a versioned diagnosis draft write for an injected Agent token', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      auditId: 'audit-1',
      data: { draftVersion: 1 },
      effects: [],
      requestId: 'request-1',
      warnings: [],
    }))
    const execute = createHttpExecutor({
      baseUrl: 'http://127.0.0.1:51868',
      credential: { kind: 'agent', token: 'cma_synthetic_task_token' },
      fetch,
    })

    await execute('encounter.diagnosis.draft.set', {
      encounterId: 'encounter-1',
      encounterVersion: '3',
      entries: [{ catalogItemId: 'diagnosis-1', role: 'primary' }],
      expectedDraftVersion: 0,
    }, { idempotencyKey: 'diagnosis-draft-call-1' })

    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(
      'http://127.0.0.1:51868/api/his/v1/encounters/encounter-1/diagnosis/draft',
    )
    expect(init).toMatchObject({
      body: JSON.stringify({
        expectedVersions: { 'Encounter/encounter-1': '3' },
        input: {
          entries: [{ catalogItemId: 'diagnosis-1', role: 'primary' }],
          expectedDraftVersion: 0,
        },
      }),
      headers: {
        accept: 'application/json',
        authorization: 'Bearer cma_synthetic_task_token',
        'content-type': 'application/json',
        'idempotency-key': 'diagnosis-draft-call-1',
      },
      method: 'PUT',
    })
  })

  it('encodes one declared FHIR search without forwarding the resource type as a parameter', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      entry: [],
      link: [],
      resourceType: 'Bundle',
      total: 0,
      type: 'searchset',
    }))
    const execute = createHttpExecutor({
      baseUrl: 'http://127.0.0.1:51868',
      credential: { kind: 'agent', token: 'cma_synthetic_task_token' },
      fetch,
    })

    await execute('fhir.resource.search', {
      parameters: {
        _count: '20',
        _total: 'accurate',
        name: '合成患者',
      },
      resourceType: 'Patient',
    })

    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(
      'http://127.0.0.1:51868/fhir/R5/Patient?_count=20&_total=accurate&name=%E5%90%88%E6%88%90%E6%82%A3%E8%80%85',
    )
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('maps a FHIR OperationOutcome to the structured CLI error contract', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      issue: [{
        code: 'not-supported',
        diagnostics: 'Search parameter name is not supported for Condition',
        severity: 'error',
      }],
      resourceType: 'OperationOutcome',
    }, { status: 400 }))
    const execute = createHttpExecutor({
      baseUrl: 'http://127.0.0.1:51868',
      credential: { kind: 'agent', token: 'cma_synthetic_task_token' },
      fetch,
    })

    await expect(execute('fhir.resource.search', {
      parameters: { patient: 'Patient/patient-1' },
      resourceType: 'Condition',
    })).rejects.toMatchObject({
      problem: {
        code: 'not-supported',
        message: 'Search parameter name is not supported for Condition',
        operationId: 'fhir.resource.search',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'validation',
      },
    })
  })
})
