import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { inpatientChargesSchema, inpatientFullClinicalSchema, inpatientFullClinicalResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { confirmPrimary, requestDrgReview, setupDrgReview } from './fixtures/inpatient-drg-review.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function reviewedService(s: Awaited<ReturnType<typeof setupDrgReview>>) {
  expect((await confirmPrimary(s)).status).toBe(200)
  const service = s.clinicalCatalog.services.find(item => item.id === 'hospital-service-diabetes-education')!
  expect(service.priceFen).toBe(3000)
  const selection = { kind: 'service' as const, serviceId: service.id, serviceVersion: service.version, quantity: 1 }
  const draft = { medications: [], services: [{ serviceId: service.id, serviceVersion: service.version, quantity: 1 }] }
  const evaluated = inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/simulation`, draft)).json())
  const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
  return { draft, input: { encounterVersion: clinical.encounterVersion, duration: 'temporary' as const,
    selection, expectedDrgFingerprint: evaluated.fingerprint } }
}

describe('同一 DRG 审阅后的公共 HTTP 并发开具', () => {
  it('两个独立数据库连接持同一审阅、不同幂等键并发开具，仅一个成功，冲突方须重新审阅', async () => {
    const s = await setupDrgReview(cleanups)
    const { draft, input } = await reviewedService(s)
    const peer = await s.openPeer()
    const keys = [randomUUID(), randomUUID()] as const
    const responses = await Promise.all([
      s.request(s.doctor, `${s.path}/orders/issue`, input, keys[0]),
      requestDrgReview(peer, s.doctor, `${s.path}/orders/issue`, input, keys[1]),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const winner = responses.findIndex(response => response.status === 200)
    const loser = winner === 0 ? 1 : 0
    const accepted = inpatientFullClinicalResponseSchema.parse(await responses[winner]!.json())
    expect(apiErrorSchema.parse(await responses[loser]!.json()).error.code).toBe('INPATIENT_DRG_EVALUATION_STALE')
    expect(accepted.data.orders).toHaveLength(1)
    expect(accepted.data.charges).toEqual([])

    const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
    expect(clinical.orders).toHaveLength(1)
    expect(clinical.orders[0]!.id).toBe(accepted.data.orders[0]!.id)
    const current = inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json())
    expect(current.committed.items).toHaveLength(1)
    expect(current.committed.items[0]!.estimatedFen).toBe(3000)
    expect(current.coverage.estimatedTotalFen).toBe(3000)
    expect(current.formal.chargesFen).toBe(0)
    expect(inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/orders/issue`, input, keys[winner])).json())).toEqual(accepted)

    // A rejected attempt creates no order or receipt; a new review explicitly authorizes the next order.
    expect((await s.request(s.doctor, `/api/his/v1/command-receipts?operationId=inpatient.order.issue&idempotencyKey=${keys[loser]}`)).status).toBe(404)
    const fresh = inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/simulation`, draft)).json())
    expect(fresh.fingerprint).not.toBe(input.expectedDrgFingerprint)
    const retried = await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, expectedDrgFingerprint: fresh.fingerprint }, keys[loser])
    expect(retried.status).toBe(200)
    expect(inpatientFullClinicalResponseSchema.parse(await retried.json()).data.orders).toHaveLength(2)
  })

  it('同键并发及丢弃响应后的回执恢复，执行和重启后重试均不重复开具或记费', async () => {
    const s = await setupDrgReview(cleanups)
    const { input } = await reviewedService(s)
    const peer = await s.openPeer()
    const key = randomUUID()
    const responses = await Promise.all([
      s.request(s.doctor, `${s.path}/orders/issue`, input, key),
      requestDrgReview(peer, s.doctor, `${s.path}/orders/issue`, input, key),
    ])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    // Discard one committed response to model a caller that cannot observe its result.
    await responses[0]!.body?.cancel()
    const accepted = inpatientFullClinicalResponseSchema.parse(await responses[1]!.json())
    expect(accepted.data.orders).toHaveLength(1)
    const order = accepted.data.orders[0]!
    const lookup = `/api/his/v1/command-receipts?operationId=inpatient.order.issue&idempotencyKey=${key}`
    const receipt = commandReceiptLookupSchema.parse(await (await requestDrgReview(peer, s.doctor, lookup)).json())
    expect(receipt.status).toBe('completed')
    expect(inpatientFullClinicalResponseSchema.parse(receipt.response)).toEqual(accepted)

    const verified = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })
    expect(verified.status).toBe(200)
    const checked = inpatientFullClinicalResponseSchema.parse(await verified.json()).data
    expect(checked.executions).toHaveLength(1)
    const execution = checked.executions[0]!
    const completed = await s.request(s.nurse, `${s.path}/executions/complete`, {
      executionId: execution.id, expectedExecutionVersion: execution.version,
    })
    expect(completed.status).toBe(200)
    const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    expect(charges.charges).toHaveLength(1)
    expect(charges.charges[0]).toMatchObject({ sourceId: execution.id, kind: 'service', amountFen: 3000 })
    expect(charges.chargesFen).toBe(3000)

    await s.restart()
    const restored = commandReceiptLookupSchema.parse(await (await s.request(s.doctor, lookup)).json())
    expect(restored).toEqual(receipt)
    const replayed = await s.request(s.doctor, `${s.path}/orders/issue`, input, key)
    expect(replayed.status).toBe(200)
    expect(inpatientFullClinicalResponseSchema.parse(await replayed.json())).toEqual(accepted)
    const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
    expect(clinical.orders).toHaveLength(1)
    expect(clinical.orders[0]).toMatchObject({ id: order.id, state: 'completed' })
    expect(clinical.executions).toHaveLength(1)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())).toEqual(charges)
    const simulated = inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json())
    expect(simulated.committed.items).toEqual([])
    expect(simulated.formal.items).toHaveLength(1)
    expect(simulated.formal.chargesFen).toBe(3000)
    expect(simulated.coverage.estimatedTotalFen).toBe(3000)
    expect(inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json())).toEqual(simulated)
  })
})
