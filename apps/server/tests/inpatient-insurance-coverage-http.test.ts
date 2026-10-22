import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { insurancePreviewResponseSchema, insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { InpatientBilling } from '../src/application/inpatient-billing.ts'
import { inpatientInsuranceFixture } from './fixtures/insurance-inpatient.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

it.each([
  ['employee-v1', 5000, 1000000, 2000, 1063021],
  ['resident-v1', 10000, 500000, 0, 1565021],
] as const)('%s 住院目录、整数分先付和基金封顶参与公开待遇及补偿核对', async (planCode, deductibleFen, fundFen, accountFen, patientFen) => {
  const s = await inpatientInsuranceFixture()
  cleanups.push(s.close)
  const admission = await s.admit()
  const actor = sessionContextSchema.parse(await (await s.runtime.app.request('/api/auth/context', {
    headers: { cookie: await s.login('cashier') },
  })).json()).actor
  const context = { workspaceId: actor.workspaceId, epoch: actor.epoch, actorId: actor.actorId, roleCode: actor.roleCode, scenarioRunId: actor.scenarioRunId }
  // This adapter matrix arranges authoritative synthetic charges through the real billing owner.
  // Clinical issue/execution matrices own when those charges are created; no imaging pixels are needed.
  const billing = new InpatientBilling(s.runtime.database, s.runtime.fhir)
  s.runtime.database.driver.transaction(() => {
    for (const [kind, amountFen] of [
      ['medication', 10003], ['imaging', 20007], ['material', 30011], ['service', 2000000], ['bed', 5000],
    ] as const) billing.record(context, {
      admissionId: admission.id, organizationId: actor.organizationId, kind, amountFen,
      sourceId: randomUUID(), serviceDate: '2026-08-24', virtualTime: '2026-08-24T09:00:00+08:00', label: `合成医保目录 ${kind}`,
    }, [])
  })()
  await s.depart(admission)
  const chargesResponse = await s.request('cashier', `/api/his/v1/inpatient/admissions/${admission.id}/charges`)
  expect(chargesResponse.status).toBe(200)
  const charges = inpatientChargesSchema.parse(await chargesResponse.json())
  expect(charges.chargesFen).toBe(2065021)
  const response = await s.insurance(admission.id, 'preview', { planCode })
  expect(response.status).toBe(200)
  const preview = insurancePreviewResponseSchema.parse(await response.json()).data
  const allocation = (kind: string) => preview.settlement.allocations.find(row =>
    row.reference === `ChargeItem/${charges.charges.find(charge => charge.kind === kind)!.id}`)!
  expect(allocation('medication')).toMatchObject({ amountFen: 10003, priorSelfPayFen: 1000, eligibleFen: 9003, outsideFen: 0 })
  expect(allocation('imaging')).toMatchObject({ amountFen: 20007, priorSelfPayFen: 2000, eligibleFen: 18007, outsideFen: 0 })
  expect(allocation('material')).toMatchObject({ amountFen: 30011, outsideFen: 30011, eligibleFen: 0, fundFen: 0, accountFen: 0, patientFen: 30011 })
  expect(preview.settlement).toMatchObject({ totalFen: 2065021, eligibleFen: 2032010, deductibleFen, fundFen, accountFen, patientFen })
  for (const row of preview.settlement.allocations) expect(row.fundFen + row.accountFen + row.patientFen).toBe(row.amountFen)
  const confirmedResponse = await s.insurance(admission.id, 'confirm', { previewId: preview.previewId, commitToken: preview.commitToken })
  expect(confirmedResponse.status).toBe(200)
  const confirmed = insuranceResponseSchema.parse(await confirmedResponse.json()).data
  expect(confirmed.balance).toMatchObject({ inpatientEligibleFen: 2032010, inpatientFundFen: fundFen, accountFen: 0, version: 1 })
  const cancel = { settlementId: confirmed.active!.id, expectedBalanceVersion: confirmed.balance.version }, key = randomUUID()
  const cancelledResponse = await s.insurance(admission.id, 'cancel', cancel, key)
  expect(cancelledResponse.status).toBe(200)
  const cancelled = insuranceResponseSchema.parse(await cancelledResponse.json())
  expect(cancelled.data.balance).toMatchObject({ inpatientEligibleFen: 0, inpatientFundFen: 0, accountFen, version: 2 })
  expect(cancelled.data.history).toHaveLength(2)
  const replay = await s.insurance(admission.id, 'cancel', cancel, key)
  expect(replay.status).toBe(200)
  expect(insuranceResponseSchema.parse(await replay.json())).toEqual(cancelled)
})
