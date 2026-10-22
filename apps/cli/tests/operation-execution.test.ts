import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { createHttpExecutor } from '../src/http-executor.ts'

function captureStream() {
  let value = ''
  return {
    stream: { write: (chunk: string) => { value += chunk } },
    value: () => value,
  }
}

describe('catalog-backed operation execution', () => {
  it('reads a unified bill through the cashier command without forwarding the case as a query parameter', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const fetch = vi.fn().mockResolvedValue(Response.json({
      accountId: 'account-1', caseId: 'case-1', encounterId: 'encounter-1',
      charges: [{ amountFen: 1000, category: 'registration', chargeItemId: 'charge-registration',
        chargeVersion: 1, descriptionEn: 'Registration', descriptionZh: '挂号费',
        paidFen: 0, remainingFen: 1000, status: 'billable' }],
      paidFen: 0, remainingFen: 1000, totalFen: 1000, payments: [], paymentsPagination: { page: 2, pageSize: 10, total: 0 },
      patient: { id: 'patient-1', identifier: 'CM-SYNTHETIC-1', name: '合成收费患者', synthetic: true, versionId: '1' },
    }))
    const execute = createHttpExecutor({
      baseUrl: 'http://127.0.0.1:51868', credential: { kind: 'agent', token: 'cma_synthetic' }, fetch,
    })
    const exitCode = await runCli(['billing', 'case', 'get', '--case-id', 'case-1', '--page', '2', '--page-size', '10'], {
      stdout: stdout.stream, stderr: stderr.stream,
    }, { authMode: 'agent', execute })
    expect(exitCode).toBe(0)
    expect(stderr.value()).toBe('')
    expect(String(fetch.mock.calls[0]![0])).toBe('http://127.0.0.1:51868/api/his/v1/billing/cases/case-1?page=2&pageSize=10')
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: true, data: { paidFen: 0, remainingFen: 1000, charges: [{ category: 'registration', status: 'billable' }] },
    })
  })

  it('preserves payment and charge versions when the cashier requests recovery through typed flags', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const fetch = vi.fn().mockResolvedValue(Response.json({
      auditId: 'audit-1', effects: [], requestId: 'request-1', warnings: [],
      data: { amountFen: 300, outcome: 'ambiguous', paymentId: 'payment-1', status: 'ambiguous' },
    }))
    const execute = createHttpExecutor({
      baseUrl: 'http://127.0.0.1:51868', credential: { kind: 'agent', token: 'cma_synthetic' }, fetch,
    })
    const exitCode = await runCli([
      'payment', 'recover', '--payment-id', 'payment-1', '--charge-item-id', 'charge-1',
      '--charge-version', '3', '--expected-payment-version', '2', '--idempotency-key', 'recovery-1',
    ], { stdout: stdout.stream, stderr: stderr.stream }, { authMode: 'agent', execute })
    expect(exitCode).toBe(0)
    expect(stderr.value()).toBe('')
    const [url, request] = fetch.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:51868/api/his/v1/payments/payment-1/actions/recover')
    expect(request).toMatchObject({ method: 'POST', headers: { 'idempotency-key': 'recovery-1' } })
    expect(JSON.parse(request.body)).toEqual({
      expectedVersions: { 'ChargeItem/charge-1': '3' }, input: { expectedPaymentVersion: 2 },
    })
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: true, data: { data: { outcome: 'ambiguous', paymentId: 'payment-1' } },
      operation: { id: 'payment.recover', mode: 'command' },
    })
  })

  it('queries the laboratory catalog in one authorized case context', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const execute = vi.fn().mockResolvedValue({
      items: [],
      page: 2,
      pageSize: 20,
      total: 0,
    })

    const exitCode = await runCli([
      'doctor', 'case', 'laboratory-catalog', 'search',
      '--case-id', 'case-1',
      '--query', '血常规',
      '--page', '2',
    ], { stderr: stderr.stream, stdout: stdout.stream }, { execute })

    expect(exitCode).toBe(0)
    expect(stderr.value()).toBe('')
    expect(execute).toHaveBeenCalledWith('doctor.case.laboratory-catalog.search', {
      caseId: 'case-1',
      page: 2,
      pageSize: 20,
      query: '血常规',
    })
    expect(JSON.parse(stdout.value())).toMatchObject({
      data: { items: [], page: 2, total: 0 },
      ok: true,
      operation: { id: 'doctor.case.laboratory-catalog.search', mode: 'query' },
    })
  })

  it('parses typed flags and validates the executor response', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const execute = vi.fn().mockResolvedValue({
      items: [],
      page: 2,
      pageSize: 20,
      releaseId: 'reference-release-current',
      total: 0,
    })

    const exitCode = await runCli([
      'reference',
      'diagnoses',
      'search',
      '--query',
      '糖尿病',
      '--page',
      '2',
    ], { stderr: stderr.stream, stdout: stdout.stream }, { execute })

    expect(exitCode).toBe(0)
    expect(stderr.value()).toBe('')
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith('reference.diagnoses.search', {
      page: 2,
      pageSize: 20,
      query: '糖尿病',
    })
    expect(JSON.parse(stdout.value())).toMatchObject({
      data: {
        items: [],
        page: 2,
        releaseId: 'reference-release-current',
      },
      ok: true,
      operation: {
        id: 'reference.diagnoses.search',
        mode: 'query',
        version: 1,
      },
      schemaVersion: 1,
    })
  })

  it('reads strict nested input from a workspace file and keeps idempotency out of business input', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'clinmesh-cli-'))
    try {
      const inputPath = join(workspace, 'diagnosis-draft.json')
      await writeFile(inputPath, JSON.stringify({
        encounterId: 'encounter-1',
        encounterVersion: '3',
        entries: [{ catalogItemId: 'diagnosis-1', role: 'primary' }],
        expectedDraftVersion: 0,
      }))
      const stdout = captureStream()
      const stderr = captureStream()
      const execute = vi.fn().mockResolvedValue({
        auditId: 'audit-1',
        data: { draftVersion: 1 },
        effects: [],
        requestId: 'request-1',
        warnings: [],
      })

      const exitCode = await runCli([
        'encounter', 'diagnosis', 'draft', 'set',
        '--input', '@diagnosis-draft.json',
        '--idempotency-key', 'diagnosis-draft-call-1',
      ], { stderr: stderr.stream, stdout: stdout.stream }, {
        cwd: workspace,
        execute,
      })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(execute).toHaveBeenCalledWith(
        'encounter.diagnosis.draft.set',
        {
          encounterId: 'encounter-1',
          encounterVersion: '3',
          entries: [{ catalogItemId: 'diagnosis-1', role: 'primary' }],
          expectedDraftVersion: 0,
        },
        { idempotencyKey: 'diagnosis-draft-call-1' },
      )
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })
})
