import { randomUUID } from 'node:crypto'
import { insurancePreviewResponseSchema, insuranceResponseSchema, insuranceStateSchema } from '@clinmesh/contracts/insurance'
import { inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema, inpatientPaymentsSchema,
  inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { afterEach, describe, expect, it } from 'vitest'
import { inpatientInsuranceFixture } from './fixtures/insurance-inpatient.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

describe('普通住院合成医保公共 HTTP', () => {
  it('跨年撤销核对原年度余额并保留当年账户', async () => {
    const s = await inpatientInsuranceFixture()
    cleanups.push(s.close)
    const admission = await s.admit()
    expect((await s.request('admin', '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-27T00:00:00+08:00',
    })).status).toBe(200)
    await s.depart(admission)
    const preview = insurancePreviewResponseSchema.parse(await (await s.insurance(admission.id, 'preview', { planCode: 'employee-v1' })).json()).data
    const original = insuranceResponseSchema.parse(await (await s.insurance(admission.id, 'confirm', {
      previewId: preview.previewId, commitToken: preview.commitToken,
    })).json()).data
    expect((await s.request('admin', '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: '2026-08-27T00:00:00+08:00', targetVirtualTime: '2027-01-01T00:00:00+08:00',
    })).status).toBe(200)
    const cancelled = await s.insurance(admission.id, 'cancel', {
      settlementId: original.active!.id, expectedBalanceVersion: original.balance.version,
    })
    expect(cancelled.status).toBe(200)
    const result = insuranceResponseSchema.parse(await cancelled.json()).data
    expect(result.balance).toMatchObject({ year: '2027', version: 0, accountFen: 0 })
    expect(result.history.at(-1)).toMatchObject({ year: '2026', reversesId: original.active!.id })
    const read = insuranceStateSchema.parse(await (await s.request('cashier', `/api/his/v1/insurance/inpatient/${admission.id}`)).json())
    expect(read).toMatchObject({ annualBalances: [{ year: '2026', version: 2, accountFen: 2000 }, { year: '2027', version: 0 }] })
  })
  it('未知组合补缴阻止待遇撤销及首次结算，原尝试恢复后可补偿重审且只收一次', async () => {
    const s = await inpatientInsuranceFixture()
    cleanups.push(s.close)
    const admission = await s.admit()
    expect((await s.request('admin', '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-27T00:00:00+08:00',
    })).status).toBe(200)
    await s.depart(admission)
    const insurancePreview = insurancePreviewResponseSchema.parse(await (await s.insurance(admission.id, 'preview', { planCode: 'employee-v1' })).json()).data
    const allocation = insuranceResponseSchema.parse(await (await s.insurance(admission.id, 'confirm', {
      previewId: insurancePreview.previewId, commitToken: insurancePreview.commitToken,
    })).json()).data
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    const paymentPreview = await s.request('cashier', `${path}/payments/preview`, { kind: 'supplement', amountFen: 5000,
      tenders: [{ method: 'cash', amountFen: 2000 }, { method: 'bank-card', amountFen: 3000 }], simulatorRule: 'ambiguous' })
    expect(paymentPreview.status).toBe(200)
    const reviewed = inpatientPaymentPreviewResponseSchema.parse(await paymentPreview.json()).data
    const paymentResponse = await s.request('cashier', `${path}/payments/confirm`, { previewId: reviewed.previewId, commitToken: reviewed.commitToken })
    expect(paymentResponse.status).toBe(200)
    const payment = inpatientPaymentResponseSchema.parse(await paymentResponse.json()).data
    expect(payment.outcome).toBe('ambiguous')
    const first = inpatientSettlementPreviewSchema.parse(await (await s.request('cashier', `${path}/discharge/preview`)).json())
    const settleInput = { encounterVersion: first.encounterVersion, fingerprint: first.fingerprint, expectedChargesFen: first.chargesFen, expectedBalanceFen: first.balanceFen }
    const blocked = await s.request('cashier', `${path}/discharge/settle`, settleInput)
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).error.code).toBe('INPATIENT_FUNDS_PENDING')
    const cancelInput = { settlementId: allocation.active!.id, expectedBalanceVersion: allocation.balance.version }
    const cancelBlocked = await s.insurance(admission.id, 'cancel', cancelInput)
    expect(cancelBlocked.status).toBe(409)
    expect((await cancelBlocked.json()).error.code).toBe('INPATIENT_FUNDS_PENDING')
    const recovery = { paymentId: payment.paymentId, expectedPaymentVersion: payment.version }, recoveryKey = randomUUID()
    const recovered = inpatientPaymentResponseSchema.parse(await (await s.request('cashier', `${path}/payments/recover`, recovery, recoveryKey)).json())
    expect(recovered.data).toMatchObject({ outcome: 'success', version: 2 })
    expect(await (await s.request('cashier', `${path}/payments/recover`, recovery, recoveryKey)).json()).toEqual(recovered)
    expect((await s.insurance(admission.id, 'cancel', cancelInput)).status).toBe(200)
    expect((await s.request('cashier', `${path}/discharge/settle`, settleInput)).status).toBe(409)
    const replacement = insurancePreviewResponseSchema.parse(await (await s.insurance(admission.id, 'preview', { planCode: 'employee-v1' })).json()).data
    expect((await s.insurance(admission.id, 'confirm', { previewId: replacement.previewId, commitToken: replacement.commitToken })).status).toBe(200)
    const fresh = inpatientSettlementPreviewSchema.parse(await (await s.request('cashier', `${path}/discharge/preview`)).json())
    const completed = await s.request('cashier', `${path}/discharge/settle`, { encounterVersion: fresh.encounterVersion,
      fingerprint: fresh.fingerprint, expectedChargesFen: fresh.chargesFen, expectedBalanceFen: fresh.balanceFen })
    expect(completed.status).toBe(200)
    const frozen = inpatientSettlementResponseSchema.parse(await completed.json()).data
    expect(frozen.transactions).toHaveLength(1)
    expect(frozen.transactions[0]).toMatchObject({ id: payment.paymentId, kind: 'supplement', amountFen: 5000 })
    expect(frozen.insurance).toMatchObject({ fundFen: 8000, accountFen: 2000, patientFen: 5000 })
  })
  it.each([
    ['employee-v1', 8000, 2000, 5000],
    ['resident-v1', 3000, 0, 12000],
  ] as const)('%s 由原费用分配基金、账户及患者自付，重复确认与撤销不重复累计', async (planCode, fundFen, accountFen, patientFen) => {
    const s = await inpatientInsuranceFixture()
    cleanups.push(s.close)
    const admission = await s.admit()
    const advance = await s.request('admin', '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-27T00:00:00+08:00',
    })
    expect(advance.status).toBe(200)
    await s.depart(admission)
    const path = `/api/his/v1/insurance/inpatient/${admission.id}`
    const command = async (action: string, input: unknown, key = randomUUID()) => s.runtime.app.request(`${path}/${action}`, {
      method: 'POST', headers: { cookie: await s.login('cashier'), origin: 'http://localhost',
        'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ input, expectedVersions: {} }),
    })
    const preview = await command('preview', { planCode })
    expect(preview.status).toBe(200)
    const data = insurancePreviewResponseSchema.parse(await preview.json()).data
    expect(data.settlement).toMatchObject({ totalFen: 15000, eligibleFen: 15000, fundFen, accountFen, patientFen })
    const input = { previewId: data.previewId, commitToken: data.commitToken }, key = randomUUID()
    const confirmed = await command('confirm', input, key)
    expect(confirmed.status).toBe(200)
    const result = insuranceResponseSchema.parse(await confirmed.json())
    expect(result.data.active).toMatchObject({ fundFen, accountFen, patientFen })
    expect(result.data.balance).toMatchObject({ inpatientEligibleFen: 15000, inpatientFundFen: fundFen, outpatientEligibleFen: 0 })
    expect(await (await command('confirm', input, key)).json()).toEqual(result)
    const firstPreview = await s.request('cashier', `/api/his/v1/inpatient/admissions/${admission.id}/discharge/preview`)
    expect(firstPreview.status).toBe(200)
    expect(inpatientSettlementPreviewSchema.parse(await firstPreview.json())).toMatchObject({
      chargesFen: 15000, balanceFen: patientFen,
      insurance: { id: result.data.active!.id, fundFen, accountFen, patientFen },
    })
    const funds = await s.request('cashier', `/api/his/v1/inpatient/admissions/${admission.id}/payments`)
    expect(funds.status).toBe(200)
    expect(inpatientPaymentsSchema.parse(await funds.json())).toMatchObject({ remainingFen: patientFen, pendingCount: 0 })
    const cancel = { settlementId: result.data.active!.id, expectedBalanceVersion: result.data.balance.version }, cancelKey = randomUUID()
    const cancelled = await command('cancel', cancel, cancelKey)
    expect(cancelled.status).toBe(200)
    const reversed = insuranceResponseSchema.parse(await cancelled.json())
    expect(reversed.data.active).toBeUndefined()
    expect(reversed.data.balance).toMatchObject({ inpatientEligibleFen: 0, inpatientFundFen: 0, accountFen: planCode === 'employee-v1' ? 2000 : 0 })
    expect(reversed.data.history.some(item => item.reversesId === result.data.active!.id)).toBe(true)
    expect(await (await command('cancel', cancel, cancelKey)).json()).toEqual(reversed)
  })
})
