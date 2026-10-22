import { randomUUID } from 'node:crypto'
import { insurancePreviewResponseSchema, insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { inpatientSettlementPreviewSchema } from '@clinmesh/contracts/inpatient-discharge'
import { afterEach, describe, expect, it } from 'vitest'
import { inpatientInsuranceFixture } from './fixtures/insurance-inpatient.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

describe('普通住院合成医保公共 HTTP', () => {
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
