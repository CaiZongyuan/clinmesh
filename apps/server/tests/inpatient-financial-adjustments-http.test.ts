import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { advanceVirtualTimeResponseSchema, inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDischargeResponseSchema, inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientFinancialSchema, inpatientFinancialResponseSchema, inpatientFinancialRefundPreviewResponseSchema } from '@clinmesh/contracts/inpatient-finance'
import { refundResponseSchema } from '@clinmesh/contracts/refunds'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup({ splitDeposits = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-financial-adjustment-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key: string = randomUUID()) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': key }, ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  }
  const registrar = await login('registrar'), cashier = await login('cashier'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), admin = await login('admin')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成归档财务患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  const patient = createPatientResponseSchema.parse(await created.json()).data.patient
  const registered = inpatientCommandResponseSchema.parse(await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: splitDeposits ? 2500 : 10000 })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  const received = await request(nurse, `${path}/receive`, { encounterVersion: registered.versionId, bedId: 'bed-general-1' })
  expect(received.status).toBe(200)
  if (splitDeposits) {
    const extra = inpatientPaymentPreviewResponseSchema.parse(await (await request(cashier, `${path}/payments/preview`, {
      kind: 'deposit', amountFen: 2500, tenders: [{ method: 'mobile', amountFen: 2500 }], simulatorRule: 'success' })).json()).data
    expect((await request(cashier, `${path}/payments/confirm`, { previewId: extra.previewId, commitToken: extra.commitToken })).status).toBe(200)
  }
  const advanced = await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })
  expect(advanced.status).toBe(200)
  advanceVirtualTimeResponseSchema.parse(await advanced.json())
  const issued = await request(doctor, `${path}/discharge/issue`, { encounterVersion: inpatientCommandResponseSchema.parse(await received.json()).data.admission.versionId, reason: '合成治疗完成' })
  const departed = await request(nurse, `${path}/discharge/depart`, { encounterVersion: inpatientDischargeResponseSchema.parse(await issued.json()).data.admission.versionId, reason: '完成出区核对', departureMethod: 'home' })
  expect(departed.status).toBe(200)
  inpatientDischargeResponseSchema.parse(await departed.json())
  const preview = inpatientSettlementPreviewSchema.parse(await (await request(cashier, `${path}/discharge/preview`)).json())
  const settlement = await request(cashier, `${path}/discharge/settle`, { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint,
    expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })
  expect(settlement.status).toBe(200)
  const settled = inpatientSettlementResponseSchema.parse(await settlement.json()).data
  const cleared = await request(nurse, `${path}/discharge/clear`, { encounterVersion: settled.encounterVersion, reason: '完成床单位清洁' })
  expect(cleared.status).toBe(200)
  inpatientDischargeResponseSchema.parse(await cleared.json())
  return { path, request, login, cashier, doctor, nurse, registrar, admin, settled, runtime: () => runtime,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

describe('首次结算后的财务更正公共 HTTP', () => {
  it.each(['increase', 'decrease'] as const)('部分 %s 结果未知时拒绝新预览及旧预览确认，查清后允许继续结清', async direction => {
    const s = await setup({ splitDeposits: true }), path = `${s.path}/financial-adjustments`
    const read = async () => inpatientFinancialSchema.parse(await (await s.request(s.cashier, path)).json())
    const before = await read()
    expect(before.sources).toHaveLength(2)
    const bill = inpatientFinancialResponseSchema.parse(await (await s.request(s.cashier, path, {
      chargeId: before.charges[0]!.chargeId, direction, amountFen: 3000,
      expectedFingerprint: before.fingerprint, reason: '合成部分资金结果核对',
    })).json()).data
    const moneyPath = `${path}/${direction === 'increase' ? 'payments' : 'refunds'}`
    const previewMoney = (current: typeof bill, amountFen: number, sourceIndex: number, simulatorRule: 'ambiguous' | 'success') => {
      const source = current.sources[sourceIndex]!
      return s.request(s.cashier, `${moneyPath}/preview`, {
        adjustmentId: bill.adjustments[0]!.adjustmentId, amountFen, expectedFingerprint: current.fingerprint, simulatorRule,
        ...(direction === 'increase' ? { tenders: [{ method: 'cash', amountFen }] }
          : { sourceKind: source.sourceKind, sourceId: source.sourceId, expectedSourceVersion: source.version }),
      })
    }
    const parsePreview = async (response: Response) => {
      expect(response.status, await response.clone().text()).toBe(200)
      return (direction === 'increase' ? inpatientPaymentPreviewResponseSchema : inpatientFinancialRefundPreviewResponseSchema).parse(await response.json()).data
    }
    const first = await parsePreview(await previewMoney(bill, 2000, 0, 'ambiguous'))
    const stale = await parsePreview(await previewMoney(bill, 1000, 1, 'success'))
    const confirm = (preview: { previewId: string; commitToken: string }) => s.request(s.cashier, `${moneyPath}/confirm`, {
      previewId: preview.previewId, commitToken: preview.commitToken,
    })
    const confirmed = await confirm(first)
    expect(confirmed.status, await confirmed.clone().text()).toBe(200)
    const receipt = (direction === 'increase' ? inpatientPaymentResponseSchema : refundResponseSchema).parse(await confirmed.json()).data
    expect(receipt.outcome).toBe('ambiguous')
    const pending = await read()
    expect(pending.adjustments[0]!.status).toBe('unknown')
    const staleConfirmation = await confirm(stale)
    expect(staleConfirmation.status).toBe(409)
    expect(await staleConfirmation.json()).toMatchObject({ error: { code: 'INPATIENT_FUNDS_PENDING' } })
    // Refunds must stay blocked even when selecting another original payment.
    const blocked = await previewMoney(pending, 1000, 1, 'success')
    expect(blocked.status, await blocked.clone().text()).toBe(409)
    expect(await blocked.json()).toMatchObject({ error: { code: 'INPATIENT_FUNDS_PENDING' } })
    const recovery = direction === 'increase'
      ? { paymentId: inpatientPaymentResponseSchema.shape.data.parse(receipt).paymentId, expectedPaymentVersion: 1 }
      : { refundId: refundResponseSchema.shape.data.parse(receipt).refundId, expectedRefundVersion: 1 }
    const recovered = await s.request(s.cashier, `${moneyPath}/recover`, recovery)
    expect(recovered.status, await recovered.clone().text()).toBe(200)
    expect((direction === 'increase' ? inpatientPaymentResponseSchema : refundResponseSchema).parse(await recovered.json()).data.outcome).toBe('success')
    const final = await confirm(await parsePreview(await previewMoney(await read(), 1000, 1, 'success')))
    expect(final.status, await final.clone().text()).toBe(200)
    const current = await read()
    expect(current).toMatchObject({ remainingCollectFen: 0, remainingRefundFen: 0, reservedFen: 0, reservedCollectFen: 0 })
    expect(current.adjustments[0]!.status).toBe('completed')
    expect(direction === 'increase' ? current.payments : current.refunds).toHaveLength(2)
  })
  it('追加费用补计后只补收差额，未知原收款重启恢复且首次结算不变', async () => {
    const s = await setup()
    const before = inpatientFinancialSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json())
    const adjusted = await s.request(s.cashier, `${s.path}/financial-adjustments`, { chargeId: before.charges[0]!.chargeId,
      direction: 'increase', amountFen: 1500, expectedFingerprint: before.fingerprint, reason: '合成床日费补计更正' })
    expect(adjusted.status).toBe(200)
    const bill = inpatientFinancialResponseSchema.parse(await adjusted.json()).data
    expect(bill).toMatchObject({ frozenChargesFen: 5000, currentChargesFen: 6500, remainingCollectFen: 1500, remainingRefundFen: 0 })
    const preview = await s.request(s.cashier, `${s.path}/financial-adjustments/payments/preview`, {
      adjustmentId: bill.adjustments[0]!.adjustmentId, amountFen: 1500, expectedFingerprint: bill.fingerprint,
      tenders: [{ method: 'cash', amountFen: 1000 }, { method: 'bank-card', amountFen: 500 }], simulatorRule: 'ambiguous' })
    expect(preview.status).toBe(200)
    const reviewed = inpatientPaymentPreviewResponseSchema.parse(await preview.json()).data
    const confirmation = { previewId: reviewed.previewId, commitToken: reviewed.commitToken }, key = randomUUID()
    const response = await s.request(s.cashier, `${s.path}/financial-adjustments/payments/confirm`, confirmation, key)
    expect(response.status).toBe(200)
    const receipt = inpatientPaymentResponseSchema.parse(await response.json())
    expect(receipt.data).toMatchObject({ outcome: 'ambiguous', amountFen: 1500 })
    const pending = inpatientFinancialSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json())
    expect(pending).toMatchObject({ currentFundsFen: 5000, reservedCollectFen: 1500 })
    expect(pending.adjustments[0]!.status).toBe('unknown')
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments/payments/preview`, {
      adjustmentId: bill.adjustments[0]!.adjustmentId, amountFen: 1, expectedFingerprint: pending.fingerprint,
      tenders: [{ method: 'cash', amountFen: 1 }], simulatorRule: 'success' })).status).toBe(409)
    await s.restart()
    expect(inpatientPaymentResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments/payments/confirm`, confirmation, key)).json())).toEqual(receipt)
    const recovery = { paymentId: receipt.data.paymentId, expectedPaymentVersion: 1 }, recoveryKey = randomUUID()
    const recovered = await s.request(s.cashier, `${s.path}/financial-adjustments/payments/recover`, recovery, recoveryKey)
    expect(recovered.status).toBe(200)
    expect(inpatientPaymentResponseSchema.parse(await recovered.json()).data).toMatchObject({ outcome: 'success', version: 2 })
    const replayed = await s.request(s.cashier, `${s.path}/financial-adjustments/payments/recover`, recovery, recoveryKey)
    expect(replayed.status).toBe(200)
    inpatientPaymentResponseSchema.parse(await replayed.json())
    const current = inpatientFinancialSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json())
    expect(current).toMatchObject({ currentFundsFen: 6500, currentChargesFen: 6500, remainingCollectFen: 0, reservedCollectFen: 0 })
    expect(current.payments).toHaveLength(1)
    expect(current.adjustments[0]!.status).toBe('completed')
    const frozen = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json())
    expect(frozen.transactions).toEqual(s.settled.transactions)
    expect(frozen.settlement).toEqual(s.settled.settlement)
  })
  it('后续未知退款只挂起调整，重启查询原尝试后结清差额且不改变首次冻结资金', async () => {
    const s = await setup()
    const before = inpatientFinancialSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json())
    const adjusted = await s.request(s.cashier, `${s.path}/financial-adjustments`, { chargeId: before.charges[0]!.chargeId,
      amountFen: 2000, expectedFingerprint: before.fingerprint, reason: '合成后续床日费冲减' })
    expect(adjusted.status).toBe(200)
    const bill = inpatientFinancialResponseSchema.parse(await adjusted.json()).data, source = bill.sources[0]!
    const preview = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, {
      adjustmentId: bill.adjustments[0]!.adjustmentId, sourceKind: source.sourceKind, sourceId: source.sourceId,
      amountFen: 2000, expectedFingerprint: bill.fingerprint, expectedSourceVersion: source.version, simulatorRule: 'ambiguous' })
    expect(preview.status).toBe(200)
    const reviewed = inpatientFinancialRefundPreviewResponseSchema.parse(await preview.json()).data
    const confirmation = { previewId: reviewed.previewId, commitToken: reviewed.commitToken }, key = randomUUID()
    const response = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, confirmation, key)
    expect(response.status).toBe(200)
    const receipt = refundResponseSchema.parse(await response.json())
    expect(receipt.data).toMatchObject({ outcome: 'ambiguous', amountFen: 2000 })
    const pending = inpatientFinancialSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json())
    expect(pending).toMatchObject({ currentFundsFen: 5000, currentChargesFen: 3000, reservedFen: 2000 })
    expect(pending.adjustments[0]!.status).toBe('unknown')
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, {
      adjustmentId: bill.adjustments[0]!.adjustmentId, sourceKind: source.sourceKind, sourceId: source.sourceId,
      amountFen: 1, expectedFingerprint: pending.fingerprint, expectedSourceVersion: pending.sources[0]!.version, simulatorRule: 'success' })).status).toBe(409)
    await s.restart()
    expect(refundResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, confirmation, key)).json())).toEqual(receipt)
    const recovery = { refundId: receipt.data.refundId, expectedRefundVersion: 1 }, recoveryKey = randomUUID()
    const recovered = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/recover`, recovery, recoveryKey)
    expect(recovered.status).toBe(200)
    expect(refundResponseSchema.parse(await recovered.json()).data).toMatchObject({ outcome: 'success', version: 2 })
    const replayed = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/recover`, recovery, recoveryKey)
    expect(replayed.status).toBe(200)
    refundResponseSchema.parse(await replayed.json())
    const current = inpatientFinancialSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json())
    expect(current).toMatchObject({ currentFundsFen: 3000, currentChargesFen: 3000, remainingRefundFen: 0, reservedFen: 0 })
    expect(current.refunds).toHaveLength(1)
    expect(current.adjustments[0]!.status).toBe('completed')
    const frozen = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json())
    expect(frozen.transactions).toEqual(s.settled.transactions)
    expect(frozen.settlement).toEqual(s.settled.settlement)
    expect(inpatientDetailSchema.parse(await (await s.request(s.cashier, s.path)).json()).admission).toMatchObject({ status: 'cleared', financialStatus: 'settled' })
  })
  it('追加原费用冲减保留首次结算与清床事实，旧key不重复更正且其他岗位拒绝', async () => {
    const s = await setup()
    const beforeResponse = await s.request(s.cashier, `${s.path}/financial-adjustments`)
    expect(beforeResponse.status).toBe(200)
    const before = inpatientFinancialSchema.parse(await beforeResponse.json())
    expect(before).toMatchObject({ frozenChargesFen: 5000, currentChargesFen: 5000, currentFundsFen: 5000, remainingRefundFen: 0 })
    const input = { chargeId: before.charges[0]!.chargeId, amountFen: 2000, expectedFingerprint: before.fingerprint, reason: '合成床日费金额核对更正' }
    for (const cookie of [s.doctor, s.nurse, s.registrar, s.admin, await s.login('medical-records')]) {
      expect((await s.request(cookie, `${s.path}/financial-adjustments`, input)).status).toBe(403)
    }
    const key = randomUUID(), response = await s.request(s.cashier, `${s.path}/financial-adjustments`, input, key)
    expect(response.status).toBe(200)
    const result = inpatientFinancialResponseSchema.parse(await response.json())
    expect(result.data).toMatchObject({ frozenChargesFen: 5000, currentChargesFen: 3000, currentFundsFen: 5000, remainingRefundFen: 2000 })
    expect(result.data.adjustments).toHaveLength(1)
    expect(inpatientFinancialResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments`, input, key)).json())).toEqual(result)
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments`, input)).status).toBe(409)
    const after = inpatientSettlementPreviewSchema.parse(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json())
    expect(after.charges).toEqual(s.settled.charges)
    expect(after.transactions).toEqual(s.settled.transactions)
    expect(after.settlement).toEqual(s.settled.settlement)
    expect(inpatientDetailSchema.parse(await (await s.request(s.cashier, s.path)).json()).admission).toMatchObject({ status: 'cleared', financialStatus: 'settled', recordStatus: 'open' })
    await s.restart()
    expect(inpatientFinancialSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json()).adjustments).toHaveLength(1)
  })
})
