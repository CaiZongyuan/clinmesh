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
  it.each(['laboratory', 'imaging', 'pathology', 'medication'])(
    'keeps two %s charge targets in one encounter distinct through payment preview HTTP requests', async category => {
      const stdout = captureStream(), stderr = captureStream()
      const charges = ['charge-first', 'charge-second'].map(chargeItemId => ({
        amountFen: 800, category, chargeItemId, chargeVersion: 3,
        descriptionEn: 'Synthetic service', descriptionZh: '合成收费项目',
        paidFen: 0, remainingFen: 800, status: 'billable',
      }))
      const fetch = vi.fn().mockResolvedValueOnce(Response.json({
        accountId: 'account-1', caseId: 'case-1', encounterId: 'encounter-1', charges,
        paidFen: 0, remainingFen: 1600, totalFen: 1600, payments: [],
        paymentsPagination: { page: 1, pageSize: 20, total: 0 },
        patient: { id: 'patient-1', identifier: 'CM-SYNTHETIC-1', name: '合成收费患者', synthetic: true, versionId: '1' },
      }))
      for (const chargeItemId of ['charge-first', 'charge-second']) {
        fetch.mockResolvedValueOnce(Response.json({
          auditId: 'audit-preview', effects: [], requestId: 'request-preview', warnings: [],
          data: { allocations: [{ amountFen: 800, chargeItemId }], amountFen: 800,
            channel: 'synthetic-payment', chargeItemId, chargeVersion: 3,
            commitToken: 'synthetic-preview-token', expectedOutcome: 'success',
            expiresAt: '2026-10-26T08:05:00Z', previewId: `preview-${chargeItemId}` },
        }))
      }
      const execute = createHttpExecutor({
        baseUrl: 'http://127.0.0.1:51868', credential: { kind: 'agent', token: 'cma_synthetic' }, fetch,
      })
      expect(await runCli(['billing', 'case', 'get', '--case-id', 'case-1'],
        { stdout: stdout.stream, stderr: stderr.stream }, { authMode: 'agent', execute })).toBe(0)
      expect(JSON.parse(stdout.value())).toMatchObject({ data: { encounterId: 'encounter-1', charges } })
      for (const chargeItemId of ['charge-first', 'charge-second']) {
        expect(await runCli(['payment', 'preview', '--case-id', 'case-1', '--category', category,
          '--charge-item-id', chargeItemId, '--charge-version', '3', '--simulator-rule', 'success',
          '--idempotency-key', `preview-${chargeItemId}`],
        { stdout: stdout.stream, stderr: stderr.stream }, { authMode: 'agent', execute })).toBe(0)
      }
      expect(stderr.value()).toBe('')
      expect(fetch.mock.calls.slice(1).map(([url, request]) => ({
        url: String(url), key: request.headers['idempotency-key'], body: JSON.parse(request.body),
      }))).toEqual([
        { url: 'http://127.0.0.1:51868/api/his/v1/payments/actions/preview', key: 'preview-charge-first',
          body: { expectedVersions: { 'ChargeItem/charge-first': '3' },
            input: { caseId: 'case-1', category, chargeItemId: 'charge-first', simulatorRule: 'success' } } },
        { url: 'http://127.0.0.1:51868/api/his/v1/payments/actions/preview', key: 'preview-charge-second',
          body: { expectedVersions: { 'ChargeItem/charge-second': '3' },
            input: { caseId: 'case-1', category, chargeItemId: 'charge-second', simulatorRule: 'success' } } },
      ])
    },
  )

  it('queries the original refund with its reviewed version and never forwards a new amount or outcome', async () => {
    const stdout = captureStream(), stderr = captureStream()
    const fetch = vi.fn().mockResolvedValue(Response.json({ auditId: 'audit-refund', effects: [], requestId: 'request-refund', warnings: [],
      data: { refundId: 'refund-1', sourceKind: 'outpatient-payment', sourceId: 'payment-1', basisId: 'outpatient-charge:charge-1',
        ownerKind: 'outpatient', ownerId: 'case-1', amountFen: 300, initialOutcome: 'ambiguous', outcome: 'declined',
        correlationId: 'sim-refund-1', createdAt: '2026-10-22T00:00:00Z', resolvedAt: '2026-10-22T00:01:00Z', version: 2 } }))
    const execute = createHttpExecutor({ baseUrl: 'http://127.0.0.1:51868', credential: { kind: 'agent', token: 'cma_synthetic' }, fetch })
    const result = await runCli(['refund', 'recover', '--refund-id', 'refund-1', '--expected-refund-version', '1',
      '--charge-item-id', 'charge-1', '--charge-version', '4', '--idempotency-key', 'refund-recovery-1'],
    { stdout: stdout.stream, stderr: stderr.stream }, { authMode: 'agent', execute })
    expect(result).toBe(0)
    expect(stderr.value()).toBe('')
    const [url, request] = fetch.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:51868/api/his/v1/refunds/refund-1/actions/recover')
    expect(JSON.parse(request.body)).toEqual({ expectedVersions: { 'ChargeItem/charge-1': '4' }, input: { expectedRefundVersion: 1 } })
    expect(request.headers['idempotency-key']).toBe('refund-recovery-1')
    expect(JSON.parse(stdout.value())).toMatchObject({ ok: true, operation: { id: 'refund.recover' }, data: { data: { outcome: 'declined' } } })
  })
  it.each(['confirm','cancel'] as const)('binds insurance %s to its target path and preserves the original reviewed input',async action=>{
    const stdout=captureStream(),stderr=captureStream()
    const fetch=vi.fn().mockResolvedValue(Response.json({auditId:'audit-1',effects:[],requestId:'request-1',warnings:[],data:{target:{kind:'outpatient',id:'case-1'},balance:{patientId:'patient-1',year:'2026',version:2,accountFen:0,eligibleFen:0,fundFen:0,outpatientEligibleFen:0,outpatientFundFen:0,inpatientEligibleFen:0,inpatientFundFen:0},activeSettlements:[],history:[]}}))
    const execute=createHttpExecutor({baseUrl:'http://127.0.0.1:51868',credential:{kind:'agent',token:'cma_synthetic'},fetch})
    const flags=action==='confirm'?['--preview-id','preview-1','--commit-token','synthetic-commit-token-1']:['--settlement-id','settlement-1','--expected-balance-version','1']
    expect(await runCli(['insurance',action,'--kind','outpatient','--id','case-1',...flags,'--idempotency-key','original-insurance-key'],{stdout:stdout.stream,stderr:stderr.stream},{authMode:'agent',execute})).toBe(0)
    expect(stderr.value()).toBe('')
    const [url,request]=fetch.mock.calls[0]!
    expect(String(url)).toBe(`http://127.0.0.1:51868/api/his/v1/insurance/outpatient/case-1/${action}`)
    expect(request.headers).toMatchObject({'idempotency-key':'original-insurance-key'})
    expect(JSON.parse(request.body)).toEqual({expectedVersions:{},input:action==='confirm'?{previewId:'preview-1',commitToken:'synthetic-commit-token-1'}:{settlementId:'settlement-1',expectedBalanceVersion:1}})
  })

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
        version: 2,
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
