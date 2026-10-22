import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { insurancePreviewResponseSchema, insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { refundResponseSchema } from '@clinmesh/contracts/refunds'
import { inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema, inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientFinancialSchema, inpatientFinancialResponseSchema, inpatientFinancialRefundPreviewResponseSchema } from '@clinmesh/contracts/inpatient-finance'
import { inpatientInsuranceFixture } from './fixtures/insurance-inpatient.ts'
import { outpatientInsuranceCompetitor } from './fixtures/insurance-cross-encounter.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

async function setup() {
  const s = await inpatientInsuranceFixture()
  cleanups.push(s.close)
  const admission = await s.admit(5000)
  expect((await s.request('admin', '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
    expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-27T00:00:00+08:00',
  })).status).toBe(200)
  await s.depart(admission)
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const insuranceCommand = async (action: string, input: unknown, key = randomUUID()) => s.runtime.app.request(`/api/his/v1/insurance/inpatient/${admission.id}/${action}`, {
    method: 'POST', headers: { cookie: await s.login('cashier'), origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ input, expectedVersions: {} }),
  })
  const preview = insurancePreviewResponseSchema.parse(await (await insuranceCommand('preview', { planCode: 'employee-v1' })).json()).data
  const confirmed = await insuranceCommand('confirm', { previewId: preview.previewId, commitToken: preview.commitToken })
  expect(confirmed.status).toBe(200)
  const original = insuranceResponseSchema.parse(await confirmed.json()).data.active!
  const first = inpatientSettlementPreviewSchema.parse(await (await s.request('cashier', `${path}/discharge/preview`)).json())
  const settledResponse = await s.request('cashier', `${path}/discharge/settle`, { encounterVersion: first.encounterVersion,
    fingerprint: first.fingerprint, expectedChargesFen: first.chargesFen, expectedBalanceFen: first.balanceFen })
  expect(settledResponse.status).toBe(200)
  const settled = inpatientSettlementResponseSchema.parse(await settledResponse.json()).data
  expect((await s.request('ward-nurse', `${path}/discharge/clear`, { encounterVersion: settled.encounterVersion, reason: '合成床位清洁完成' })).status).toBe(200)
  const read = async () => inpatientFinancialSchema.parse(await (await s.request('cashier', `${path}/financial-adjustments`)).json())
  const before = await read()
  const adjusted = await s.request('cashier', `${path}/financial-adjustments`, { chargeId: before.charges[0]!.chargeId,
    amountFen: 1000, expectedFingerprint: before.fingerprint, reason: '合成医保后床日费冲减' })
  expect(adjusted.status).toBe(200)
  const bill = inpatientFinancialResponseSchema.parse(await adjusted.json()).data
  return { ...s, get runtime() { return s.runtime }, path, original, settled, read, bill, adjustmentId: bill.adjustments[0]!.adjustmentId }
}

describe('结算后医保更正公开 HTTP', () => {
  it('跨年仍补偿原2026年度，新年度门诊分摊及余额不受更正影响', async () => {
    const s = await setup(), prefix = `${s.path}/financial-adjustments/${s.adjustmentId}/insurance`
    expect((await s.request('admin', '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: '2026-08-27T00:00:00+08:00', targetVirtualTime: '2027-01-01T00:00:00+08:00',
    })).status).toBe(200)
    const competitor = await outpatientInsuranceCompetitor(s), b = await competitor.confirm(await competitor.preview())
    expect(b.active?.year).toBe('2027')
    const before = await s.read()
    expect(before.insurance!.balance.year).toBe('2026')
    const cancelled = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${prefix}/cancel`, {
      settlementId: s.original.id, expectedBalanceVersion: before.insurance!.balance.version, expectedFingerprint: before.fingerprint,
    })).json()).data
    const replacement = insurancePreviewResponseSchema.parse(await (await s.request('cashier', `${prefix}/preview`, { expectedFingerprint: cancelled.fingerprint })).json()).data
    expect(replacement.settlement).toMatchObject({ year: '2026', fundFen: 7200, accountFen: 2000, patientFen: 4800 })
    const final = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${prefix}/confirm`, { previewId: replacement.previewId, commitToken: replacement.commitToken })).json()).data
    expect(final.remainingRefundFen).toBe(200)
    expect(await competitor.read()).toEqual(b)
  })
  it('更正路由绑定路径和岗位，只开放当前Run的窄财务写且不改临床状态', async () => {
    const s = await setup(), prefix = `${s.path}/financial-adjustments/${s.adjustmentId}/insurance`
    const input = { settlementId: s.original.id, expectedBalanceVersion: 1, expectedFingerprint: s.bill.fingerprint }
    for (const role of ['registrar', 'inpatient-doctor', 'ward-nurse', 'medical-records', 'admin']) {
      expect((await s.request(role, `${prefix}/cancel`, input)).status).toBe(403)
    }
    expect((await s.request('cashier', `${prefix}/cancel`, { ...input, admissionId: 'other' })).status).toBe(400)
    expect((await s.request('cashier', `${s.path}/financial-adjustments/other/insurance/cancel`, input)).status).toBe(409)
    expect((await s.request('cashier', `${s.path}/financial-adjustments`, { chargeId: s.bill.charges[0]!.chargeId,
      amountFen: 1, expectedFingerprint: s.bill.fingerprint, reason: '拒绝并行的未完成更正' })).status).toBe(409)
    s.runtime.database.driver.prepare("UPDATE scenario_run SET status='completed' WHERE scenario_run_id='scenario-run-1'").run()
    const cancelled = await s.request('cashier', `${prefix}/cancel`, input)
    expect(cancelled.status).toBe(200)
    const bill = inpatientFinancialResponseSchema.parse(await cancelled.json()).data
    expect(bill.status).toBe('cleared')
    expect((await s.insurance(s.original.target.id, 'preview', { planCode: 'employee-v1' })).status).toBe(409)
    s.runtime.database.driver.prepare("UPDATE scenario_run SET status='closed' WHERE scenario_run_id='scenario-run-1'").run()
    expect((await s.request('cashier', `${prefix}/preview`, { expectedFingerprint: bill.fingerprint })).status).toBe(403)
  })
  it('其他门诊先占用归还账户使旧预览失效，冲减1000仍补收1800，拒绝后未知补收可重启恢复', async () => {
    const s = await setup(), prefix = `${s.path}/financial-adjustments/${s.adjustmentId}/insurance`
    const cancelled = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${prefix}/cancel`, {
      settlementId: s.original.id, expectedBalanceVersion: 1, expectedFingerprint: s.bill.fingerprint,
    })).json()).data
    const a = insurancePreviewResponseSchema.parse(await (await s.request('cashier', `${prefix}/preview`, { expectedFingerprint: cancelled.fingerprint })).json()).data
    const competitor = await outpatientInsuranceCompetitor(s)
    const b = await competitor.confirm(await competitor.preview())
    expect(b.active).toMatchObject({ accountFen: 2000, fundFen: 1820, eligibleFen: 3600 })
    const beforeStale = await s.read()
    const stale = await s.request('cashier', `${prefix}/confirm`, { previewId: a.previewId, commitToken: a.commitToken })
    expect(stale.status).toBe(409)
    expect((await s.read()).insurance).toEqual(beforeStale.insurance)
    const replacement = insurancePreviewResponseSchema.parse(await (await s.request('cashier', `${prefix}/preview`, { expectedFingerprint: beforeStale.fingerprint })).json()).data
    expect(replacement.settlement).toMatchObject({ year: '2026', fundFen: 7200, accountFen: 0, patientFen: 6800 })
    const bill = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${prefix}/confirm`, {
      previewId: replacement.previewId, commitToken: replacement.commitToken,
    })).json()).data
    expect(bill).toMatchObject({ currentChargesFen: 14000, remainingCollectFen: 1800, remainingRefundFen: 0 })
    const pay = async (rule: 'decline' | 'ambiguous') => {
      const fresh = await s.read()
      return inpatientPaymentPreviewResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/payments/preview`, {
        adjustmentId: s.adjustmentId, amountFen: 1800, expectedFingerprint: fresh.fingerprint,
        tenders: [{ method: 'cash', amountFen: 800 }, { method: 'bank-card', amountFen: 1000 }], simulatorRule: rule,
      })).json()).data
    }
    const declinedPreview = await pay('decline')
    expect(inpatientPaymentResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/payments/confirm`, {
      previewId: declinedPreview.previewId, commitToken: declinedPreview.commitToken,
    })).json()).data.outcome).toBe('declined')
    expect((await s.read()).remainingCollectFen).toBe(1800)
    const money = await pay('ambiguous'), confirmation = { previewId: money.previewId, commitToken: money.commitToken }, key = randomUUID()
    const receipt = inpatientPaymentResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/payments/confirm`, confirmation, key)).json())
    expect(receipt.data.outcome).toBe('ambiguous')
    const pending = await s.read()
    expect(pending.adjustments[0]!.status).toBe('unknown')
    expect((await s.request('cashier', `${prefix}/cancel`, { settlementId: replacement.settlement.id, expectedBalanceVersion: pending.insurance!.balance.version, expectedFingerprint: pending.fingerprint })).status).toBe(409)
    await s.restart()
    expect(await (await s.request('cashier', `${s.path}/financial-adjustments/payments/confirm`, confirmation, key)).json()).toEqual(receipt)
    const recovery = { paymentId: receipt.data.paymentId, expectedPaymentVersion: 1 }, recoveryKey = randomUUID()
    const resolved = inpatientPaymentResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/payments/recover`, recovery, recoveryKey)).json())
    expect(resolved.data).toMatchObject({ outcome: 'success', version: 2 })
    expect(await (await s.request('cashier', `${s.path}/financial-adjustments/payments/recover`, recovery, recoveryKey)).json()).toEqual(resolved)
    const final = await s.read()
    expect(final).toMatchObject({ currentFundsFen: 6800, remainingCollectFen: 0, reservedCollectFen: 0 })
    expect(final.adjustments[0]!.status).toBe('completed')
    expect(final.insurance!.balance).toMatchObject({ outpatientFundFen: 1820, outpatientEligibleFen: 3600, inpatientFundFen: 7200, accountFen: 0 })
    expect((await competitor.read()).active).toEqual(b.active)
  })
  it('未知退款重启查原尝试，只结清更正差额，待遇与临床完成事实保持不变', async () => {
    const s = await setup(), prefix = `${s.path}/financial-adjustments/${s.adjustmentId}/insurance`
    const cancel = await s.request('cashier', `${prefix}/cancel`, { settlementId: s.original.id, expectedBalanceVersion: 1, expectedFingerprint: s.bill.fingerprint })
    const cancelled = inpatientFinancialResponseSchema.parse(await cancel.json()).data
    const preview = insurancePreviewResponseSchema.parse(await (await s.request('cashier', `${prefix}/preview`, { expectedFingerprint: cancelled.fingerprint })).json()).data
    const bill = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${prefix}/confirm`, { previewId: preview.previewId, commitToken: preview.commitToken })).json()).data
    const source = bill.sources[0]!
    const declinedPreview = inpatientFinancialRefundPreviewResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/preview`, {
      adjustmentId: s.adjustmentId, sourceKind: source.sourceKind, sourceId: source.sourceId, amountFen: 200,
      expectedFingerprint: bill.fingerprint, expectedSourceVersion: source.version, simulatorRule: 'decline',
    })).json()).data
    const declined = refundResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/confirm`, {
      previewId: declinedPreview.previewId, commitToken: declinedPreview.commitToken,
    })).json()).data
    expect(declined.outcome).toBe('declined')
    const afterDecline = await s.read(), freshSource = afterDecline.sources[0]!
    expect(afterDecline).toMatchObject({ remainingRefundFen: 200, currentFundsFen: 5000 })
    const money = inpatientFinancialRefundPreviewResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/preview`, {
      adjustmentId: s.adjustmentId, sourceKind: freshSource.sourceKind, sourceId: freshSource.sourceId, amountFen: 200,
      expectedFingerprint: afterDecline.fingerprint, expectedSourceVersion: freshSource.version, simulatorRule: 'ambiguous',
    })).json()).data
    const confirmation = { previewId: money.previewId, commitToken: money.commitToken }, key = randomUUID()
    const receipt = refundResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/confirm`, confirmation, key)).json())
    expect(receipt.data.outcome).toBe('ambiguous')
    expect((await s.read()).adjustments[0]!.status).toBe('unknown')
    await s.restart()
    expect(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/confirm`, confirmation, key)).json()).toEqual(receipt)
    const recovery = { refundId: receipt.data.refundId, expectedRefundVersion: 1 }, recoveryKey = randomUUID()
    const resolved = refundResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/recover`, recovery, recoveryKey)).json())
    expect(resolved.data).toMatchObject({ outcome: 'success', version: 2 })
    expect(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/recover`, recovery, recoveryKey)).json()).toEqual(resolved)
    const final = await s.read()
    expect(final).toMatchObject({ currentFundsFen: 4800, remainingRefundFen: 0, reservedFen: 0, status: 'cleared' })
    expect(final.adjustments[0]!.status).toBe('completed')
    expect(final.insurance?.active).toEqual(bill.insurance?.active)
    expect(final.insurance?.balance).toEqual(bill.insurance?.balance)
    expect(final.refunds).toHaveLength(2)
    const frozen = inpatientSettlementPreviewSchema.parse(await (await s.request('cashier', `${s.path}/discharge/preview`)).json())
    expect(frozen.insurance).toEqual(s.settled.insurance)
    expect(frozen.transactions).toEqual(s.settled.transactions)
    expect(frozen.settlement).toEqual(s.settled.settlement)
  })
  it('追加原待遇补偿和更正后新待遇，按患者差额退200分并保留首次结算', async () => {
    const s = await setup()
    const prefix = `${s.path}/financial-adjustments/${s.adjustmentId}/insurance`
    const cancel = await s.request('cashier', `${prefix}/cancel`, { settlementId: s.original.id, expectedBalanceVersion: 1, expectedFingerprint: s.bill.fingerprint })
    expect(cancel.status).toBe(200)
    const cancelled = inpatientFinancialResponseSchema.parse(await cancel.json()).data
    expect(cancelled.insurance?.balance).toMatchObject({ year: '2026', accountFen: 2000, inpatientEligibleFen: 0 })
    const preview = await s.request('cashier', `${prefix}/preview`, { expectedFingerprint: cancelled.fingerprint })
    expect(preview.status).toBe(200)
    const reviewed = await preview.json()
    expect(reviewed.data.settlement).toMatchObject({ totalFen: 14000, fundFen: 7200, accountFen: 2000, patientFen: 4800, year: '2026' })
    const confirmation = { previewId: reviewed.data.previewId, commitToken: reviewed.data.commitToken }, key = randomUUID()
    const result = await s.request('cashier', `${prefix}/confirm`, confirmation, key)
    expect(result.status).toBe(200)
    const receipt = inpatientFinancialResponseSchema.parse(await result.json())
    expect(receipt.data).toMatchObject({ currentChargesFen: 14000, currentFundsFen: 5000, remainingRefundFen: 200, remainingCollectFen: 0 })
    expect(receipt.data.insurance?.cycles[0]).toMatchObject({ adjustmentId: s.adjustmentId, originalSettlementId: s.original.id })
    expect(await (await s.request('cashier', `${prefix}/confirm`, confirmation, key)).json()).toEqual(receipt)
    const frozen = inpatientSettlementPreviewSchema.parse(await (await s.request('cashier', `${s.path}/discharge/preview`)).json())
    expect(frozen.insurance).toEqual(s.settled.insurance)
    expect(frozen.transactions).toEqual(s.settled.transactions)
    expect(frozen.settlement).toEqual(s.settled.settlement)
  })
})
