import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli.ts'
import { createHttpExecutor } from '../src/http-executor.ts'

function captureStream() {
  let value = ''
  return {
    stream: { write: (chunk: string) => { value += chunk } },
    value: () => value,
  }
}

const admissionId = 'synthetic-admission'
const fingerprint = 'a'.repeat(64)
const timestamp = '2026-10-23T00:00:00Z'
const confirmation = { admissionId, previewId: 'synthetic-preview', commitToken: 'synthetic-preview-token' }
const paymentRecovery = { admissionId, paymentId: 'synthetic-payment', expectedPaymentVersion: 1 }
const refundRecovery = { admissionId, refundId: 'synthetic-refund', expectedRefundVersion: 1 }
const payment = {
  admissionId, paymentId: 'synthetic-payment', kind: 'supplement', amountFen: 1000,
  tenders: [{ method: 'cash', amountFen: 1000 }], initialOutcome: 'ambiguous', outcome: 'success',
  correlationId: 'synthetic-payment-result', createdAt: timestamp, resolvedAt: timestamp, version: 2,
}
const refund = {
  refundId: 'synthetic-refund', sourceKind: 'inpatient-deposit', sourceId: 'synthetic-deposit',
  basisId: 'synthetic-basis', ownerKind: 'inpatient', ownerId: admissionId, amountFen: 1000,
  initialOutcome: 'ambiguous', outcome: 'success', correlationId: 'synthetic-refund-result',
  createdAt: timestamp, resolvedAt: timestamp, version: 2,
}
const settlement = {
  admissionId, encounterVersion: '4', status: 'departed', financialStatus: 'settled',
  charges: [], chargesFen: 0, depositFen: 0, balanceFen: 0, fingerprint, transactions: [],
  settlement: { id: 'synthetic-settlement', fingerprint, chargesFen: 0, depositFen: 0, balanceFen: 0, settledAt: timestamp },
}
const finances = {
  admissionId, status: 'departed', recordStatus: 'open', firstSettlement: settlement.settlement,
  charges: [], adjustments: [], sources: [], refunds: [], payments: [], frozenChargesFen: 0,
  currentChargesFen: 0, frozenFundsFen: 0, currentFundsFen: 0, remainingRefundFen: 0,
  remainingCollectFen: 0, reservedFen: 0, reservedCollectFen: 0, fingerprint,
}
const financialCommands = [
  { command: 'adjust-finance', id: 'inpatient.financial.adjust', path: 'financial-adjustments',
    input: { admissionId, chargeId: 'synthetic-charge', direction: 'decrease', amountFen: 1000, expectedFingerprint: fingerprint, reason: '合成费用核对冲减' }, data: finances },
  { command: 'confirm-financial-refund', id: 'inpatient.financial.refund.confirm', path: 'financial-adjustments/refunds/confirm', input: confirmation, data: refund },
  { command: 'recover-financial-refund', id: 'inpatient.financial.refund.recover', path: 'financial-adjustments/refunds/recover', input: refundRecovery, data: refund },
  { command: 'confirm-financial-payment', id: 'inpatient.financial.payment.confirm', path: 'financial-adjustments/payments/confirm', input: confirmation, data: payment },
  { command: 'recover-financial-payment', id: 'inpatient.financial.payment.recover', path: 'financial-adjustments/payments/recover', input: paymentRecovery, data: payment },
  { command: 'confirm-payment', id: 'inpatient.payment.confirm', path: 'payments/confirm', input: confirmation, data: payment },
  { command: 'recover-payment', id: 'inpatient.payment.recover', path: 'payments/recover', input: paymentRecovery, data: payment },
  { command: 'confirm-refund', id: 'inpatient.refund.confirm', path: 'refunds/confirm', input: confirmation, data: refund },
  { command: 'recover-refund', id: 'inpatient.refund.recover', path: 'refunds/recover', input: refundRecovery, data: refund },
  { command: 'settle', id: 'inpatient.discharge.settle', path: 'discharge/settle',
    input: { admissionId, encounterVersion: '4', fingerprint, expectedChargesFen: 0, expectedBalanceFen: 0 }, data: settlement },
]

describe('住院财务 CLI 人工确认', () => {
  it.each(financialCommands)('$command 缺少确认时不读取输入、不发送请求', async ({ command }) => {
    const stdout = captureStream()
    const stderr = captureStream()
    const fetch = vi.fn()
    const readStdin = vi.fn().mockResolvedValue('{}')
    const execute = createHttpExecutor({
      baseUrl: 'http://127.0.0.1:51868',
      credential: { kind: 'human', cookie: 'synthetic-session' },
      fetch,
    })

    const exitCode = await runCli([
      'inpatient', command, '--input', '-', '--idempotency-key', 'synthetic-finance-intent',
    ], { stdout: stdout.stream, stderr: stderr.stream }, { authMode: 'human', execute, readStdin })

    expect(exitCode).toBe(10)
    expect(stdout.value()).toBe('')
    expect(readStdin).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.parse(stderr.value())).toMatchObject({
      ok: false,
      error: {
        code: 'confirmation_required',
        message: `Pass --yes to confirm inpatient ${command}`,
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'confirmation',
      },
    })
  })

  describe.each(['human', 'agent'] as const)('%s 模式', authMode => {
    it.each(financialCommands)('$command 按本模式的确认规则发送原输入', async ({ command, id, path, input, data }) => {
      const stdout = captureStream()
      const stderr = captureStream()
      const response = { auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-request', warnings: [], data }
      const fetch = vi.fn().mockResolvedValue(Response.json(response))
      const execute = createHttpExecutor({
        baseUrl: 'http://127.0.0.1:51868', fetch,
        credential: authMode === 'human'
          ? { kind: 'human', cookie: 'synthetic-session' }
          : { kind: 'agent', token: 'cma_synthetic' },
      })

      const exitCode = await runCli([
        'inpatient', command, '--input', '-', '--idempotency-key', 'synthetic-finance-intent',
        ...(authMode === 'human' ? ['--yes'] : []),
      ], { stdout: stdout.stream, stderr: stderr.stream }, {
        authMode, execute, readStdin: async () => JSON.stringify(input),
      })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(fetch).toHaveBeenCalledTimes(1)
      const [url, request] = fetch.mock.calls[0]!
      expect(String(url)).toBe(`http://127.0.0.1:51868/api/his/v1/inpatient/admissions/${admissionId}/${path}`)
      expect(request).toMatchObject({ method: 'POST', headers: {
        'idempotency-key': 'synthetic-finance-intent',
        ...(authMode === 'human' ? { cookie: 'synthetic-session', origin: 'http://127.0.0.1:51868' } : { authorization: 'Bearer cma_synthetic' }),
      } })
      const { admissionId: _admissionId, ...expectedInput } = input
      expect(JSON.parse(request.body)).toEqual({ input: expectedInput })
      expect(JSON.parse(stdout.value())).toMatchObject({ ok: true, operation: { id, version: 2 }, data: response })
    })
  })

  it.each([
    { command: 'financial-adjustments', args: ['--admission-id', admissionId], data: finances },
    { command: 'preview-payment', args: ['--input', '-', '--idempotency-key', 'synthetic-preview-intent'],
      data: { auditId: 'synthetic-audit', effects: [], requestId: 'synthetic-request', warnings: [], data: {
        ...confirmation, kind: 'deposit', amountFen: 1000, tenders: [{ method: 'cash', amountFen: 1000 }],
        expectedOutcome: 'success', expiresAt: timestamp, fingerprint,
      } } },
  ])('$command 人工查询和预览无需确认', async ({ command, args, data }) => {
    const stderr = captureStream()
    const fetch = vi.fn().mockResolvedValue(Response.json(data))
    const execute = createHttpExecutor({ baseUrl: 'http://127.0.0.1:51868', credential: { kind: 'human', cookie: 'synthetic-session' }, fetch })
    const exitCode = await runCli(['inpatient', command, ...args], { stdout: captureStream().stream, stderr: stderr.stream }, {
      authMode: 'human', execute,
      readStdin: async () => JSON.stringify({ admissionId, kind: 'deposit', amountFen: 1000, tenders: [{ method: 'cash', amountFen: 1000 }], simulatorRule: 'success' }),
    })
    expect(exitCode).toBe(0)
    expect(stderr.value()).toBe('')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
