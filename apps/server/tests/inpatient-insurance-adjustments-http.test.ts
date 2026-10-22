import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { insurancePreviewResponseSchema, insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientFinancialSchema, inpatientFinancialResponseSchema } from '@clinmesh/contracts/inpatient-finance'
import { inpatientInsuranceFixture } from './fixtures/insurance-inpatient.ts'

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
  return { ...s, path, original, settled, read, bill, adjustmentId: bill.adjustments[0]!.adjustmentId }
}

describe('结算后医保更正公开 HTTP', () => {
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
