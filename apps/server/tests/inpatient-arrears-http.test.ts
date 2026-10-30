import { inpatientDetailSchema, inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { afterEach, expect, it } from 'vitest'
import { inpatientInsuranceFixture } from './fixtures/insurance-inpatient.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

it('医生概要区分真实欠费、未知补缴与已结清，且不开放资金明细', async () => {
  const s = await inpatientInsuranceFixture()
  cleanups.push(s.close)
  const admission = await s.admit(1000)
  expect((await s.request('admin', '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
    expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00',
  })).status).toBe(200)
  await s.depart(admission)
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const read = async () => {
    const detail = await s.request('inpatient-doctor', path)
    expect(detail.status).toBe(200)
    return inpatientDetailSchema.parse(await detail.json()).admission
  }
  expect(await read()).toHaveProperty('outstandingFen', 4000)
  const preview = inpatientPaymentPreviewResponseSchema.parse(await (await s.request('cashier', `${path}/payments/preview`, {
    kind: 'supplement', amountFen: 4000, tenders: [{ method: 'cash', amountFen: 4000 }], simulatorRule: 'ambiguous',
  })).json()).data
  const attempt = inpatientPaymentResponseSchema.parse(await (await s.request('cashier', `${path}/payments/confirm`, {
    previewId: preview.previewId, commitToken: preview.commitToken,
  })).json()).data
  expect(await read()).toHaveProperty('outstandingFen', null)
  expect((await s.request('inpatient-doctor', `${path}/payments`)).status).toBe(403)
  expect((await s.request('inpatient-doctor', `${path}/financial-adjustments`)).status).toBe(403)
  expect((await s.request('cashier', `${path}/payments/recover`, { paymentId: attempt.paymentId, expectedPaymentVersion: attempt.version })).status).toBe(200)
  expect(await read()).toHaveProperty('outstandingFen', 0)
  const settlement = inpatientSettlementPreviewSchema.parse(await (await s.request('cashier', `${path}/discharge/preview`)).json())
  const settled = inpatientSettlementResponseSchema.parse(await (await s.request('cashier', `${path}/discharge/settle`, {
    encounterVersion: settlement.encounterVersion, fingerprint: settlement.fingerprint,
    expectedChargesFen: settlement.chargesFen, expectedBalanceFen: settlement.balanceFen,
  })).json()).data
  expect((await s.request('ward-nurse', `${path}/discharge/clear`, { encounterVersion: settled.encounterVersion, reason: '合成床位已清洁' })).status).toBe(200)
  expect(await read()).toMatchObject({ outstandingFen: 0, financialStatus: 'settled', status: 'cleared', depositFen: 1000, chargesFen: 5000 })
  const list = inpatientListSchema.parse(await (await s.request('inpatient-doctor', '/api/his/v1/inpatient/admissions')).json())
  expect(list.items.find(item => item.id === admission.id)).toHaveProperty('outstandingFen', 0)
})
