import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { apiErrorSchema, commandResponseSchema } from '@clinmesh/contracts/his'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientMaterialReservationListSchema, inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { setupDrgReview } from './fixtures/inpatient-drg-review.ts'

const responseSchema = commandResponseSchema(inpatientMaterialReservationListSchema)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setupBatch() {
  const s = await setupDrgReview(cleanups)
  const initial = inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())
  const planned = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: initial.encounterVersion,
    procedureId: 'hospital-surgery-8', catalogVersion: 1, plannedFor: initial.virtualTime, reason: '合成双导管造影计划' })
  expect(planned.status).toBe(200)
  const surgery = inpatientSurgeryResponseSchema.parse(await planned.json()).data
  const requestId = surgery.requests[0]!.id
  const read = async () => inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
  const initialReservations = await read()
  const input = { encounterVersion: surgery.encounterVersion, requestId, expectedRequestVersion: 1,
    items: [
      { materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 2, reason: '医生核对合成双导管数量' },
      { materialId: 'hospital-material-guidewire', catalogVersion: 1, quantity: 1, reason: '医生核对合成备用导丝' },
    ], expectedReservationFingerprint: initialReservations.reservationSets.find(set => set.requestId === requestId)!.fingerprint,
    reason: '医生整批确认合成耗材预留' }
  const batch = (value: unknown = input, key = randomUUID()) => s.request(s.doctor, `${s.path}/drg/reservations/replace-batch`, value, key)
  return { ...s, input, read, batch }
}

it('一次确认整份预留清单，推演归集目录金额且不产生实际材料收费', async () => {
  const s = await setupBatch()
  const before = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
  const response = await s.batch()
  expect(response.status).toBe(200)
  const saved = responseSchema.parse(await response.json())
  expect(saved.data.reservations.map(item => [item.materialId, item.quantity, item.priceFen, item.status])).toEqual([
    ['hospital-material-catheter', 2, 5000, 'reserved'], ['hospital-material-guidewire', 1, 20000, 'reserved'],
  ])
  expect(saved.effects).toHaveLength(2)
  expect(saved.data.reservations.map(item => item.unit)).toEqual(['根', '根'])
  expect(await s.read()).toEqual(saved.data)
  const simulation = inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json())
  expect(simulation.reserved.items.map(item => item.estimatedFen).sort((a, b) => a! - b!)).toEqual([10000, 20000])
  expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())).toEqual(before)
})

it('再次确认须完整审阅原预留，原子替换且不释放其他计划或未绑定的预留', async () => {
  const s = await setupBatch()
  const first = responseSchema.parse(await (await s.batch()).json()).data
  const unbound = responseSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`, {
    encounterVersion: first.encounterVersion, materialId: 'hospital-material-balloon', catalogVersion: 1, quantity: 1,
    reason: '另一用途的未绑定预留，不参与本计划调整',
  })).json()).data.reservations.find(item => item.requestId === undefined)!
  const surgery = inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())
  const other = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: surgery.encounterVersion,
    procedureId: 'hospital-surgery-7', catalogVersion: 1, plannedFor: surgery.virtualTime, reason: '另一独立造影计划' })
  expect(other.status).toBe(200)
  const otherPlan = inpatientSurgeryResponseSchema.parse(await other.json()).data.requests.find(item => item.id !== s.input.requestId)!
  const otherReservation = responseSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`, {
    encounterVersion: first.encounterVersion, requestId: otherPlan.id, materialId: 'hospital-material-catheter', catalogVersion: 1,
    quantity: 3, reason: '另一计划已审阅预留，不参与本批处理',
  })).json()).data.reservations.find(item => item.requestId === otherPlan.id)!
  const before = await s.read()
  const replacement = { ...s.input, items: [{ ...s.input.items[0]!, quantity: 1 }],
    expectedReservationFingerprint: first.reservationSets.find(set => set.requestId === s.input.requestId)!.fingerprint }
  for (const expectedReservationFingerprint of [s.input.expectedReservationFingerprint, '0'.repeat(64),
    before.reservationSets.find(set => set.requestId === otherPlan.id)!.fingerprint]) {
    const rejected = await s.batch({ ...replacement, expectedReservationFingerprint })
    expect(rejected.status).toBe(409)
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('INPATIENT_RESERVATION_CONFLICT')
    expect(await s.read()).toEqual(before)
  }
  const changed = await s.batch(replacement)
  expect(changed.status).toBe(200)
  const saved = responseSchema.parse(await changed.json()).data
  expect(saved.reservations.filter(item => item.requestId === s.input.requestId && item.status === 'reserved'))
    .toMatchObject([{ materialId: 'hospital-material-catheter', quantity: 1 }])
  expect(saved.reservations.filter(item => first.reservations.some(original => original.id === item.id)))
    .toMatchObject([{ status: 'released', version: 2, releaseReason: s.input.reason }, { status: 'released', version: 2, releaseReason: s.input.reason }])
  expect(saved.reservations.find(item => item.id === unbound.id)).toEqual(unbound)
  expect(saved.reservations.find(item => item.id === otherReservation.id)).toEqual(otherReservation)
  const simulated = inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json())
  expect(simulated.reserved.items.map(item => item.estimatedFen).sort((a, b) => a! - b!)).toEqual([5000, 15000, 40000])
})

it('失效的目录或计划版本拒绝整批调整，原预留保持有效', async () => {
  const s = await setupBatch()
  const first = responseSchema.parse(await (await s.batch()).json()).data
  const input = { ...s.input, expectedReservationFingerprint: first.reservationSets.find(set => set.requestId === s.input.requestId)!.fingerprint }
  for (const invalid of [
    { ...input, expectedRequestVersion: 99 },
    { ...input, encounterVersion: '0' },
    { ...input, items: [input.items[0]!, { ...input.items[1]!, catalogVersion: 99 }] },
  ]) {
    const response = await s.batch(invalid)
    expect(response.status).toBe(409)
    expect(await s.read()).toEqual(first)
  }
  s.runtime.database.driver.exec(`UPDATE inpatient_surgery_catalog SET version=2,
    snapshot_json=json_set(snapshot_json,'$.version',2,'$.chargeDefinition.priceFen',6000,'$.chargeDefinition.unit','新版计费根')
    WHERE item_id='hospital-material-catheter'`)
  const stale = await s.batch(input)
  expect(stale.status).toBe(409)
  expect(apiErrorSchema.parse(await stale.json()).error.code).toBe('CATALOG_CONFLICT')
  expect(await s.read()).toEqual(first)
  expect(first.reservations[0]).toMatchObject({ catalogVersion: 1, priceFen: 5000, unit: '根' })
  const reviewed = await s.batch({ ...input, items: [{ ...input.items[0]!, catalogVersion: 2 }] })
  expect(reviewed.status).toBe(200)
  const saved = responseSchema.parse(await reviewed.json()).data
  expect(saved.reservations.filter(item => item.status === 'reserved')).toMatchObject([
    { catalogVersion: 2, priceFen: 6000, unit: '新版计费根', quantity: 2 },
  ])
  expect(saved.reservations.find(item => item.id === first.reservations[0]!.id)).toMatchObject({ catalogVersion: 1, priceFen: 5000, unit: '根' })
})

it('审阅后新增或释放预留会使原集合失效，重新核对后才能整体替换', async () => {
  const s = await setupBatch()
  const first = responseSchema.parse(await (await s.batch()).json()).data
  const firstFingerprint = first.reservationSets.find(set => set.requestId === s.input.requestId)!.fingerprint
  const added = await s.request(s.doctor, `${s.path}/drg/reservations`, {
    encounterVersion: first.encounterVersion, requestId: s.input.requestId,
    materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 1, reason: '其他会话单项新增',
  })
  expect(added.status).toBe(200)
  const afterAdd = responseSchema.parse(await added.json()).data
  const addedFingerprint = afterAdd.reservationSets.find(set => set.requestId === s.input.requestId)!.fingerprint
  expect(addedFingerprint).not.toBe(firstFingerprint)
  expect((await s.batch({ ...s.input, expectedReservationFingerprint: firstFingerprint })).status).toBe(409)
  expect(await s.read()).toEqual(afterAdd)
  expect((await s.request(s.doctor, `${s.path}/drg/reservations/${first.reservations[0]!.id}/release`, {
    encounterVersion: first.encounterVersion, reason: '其他会话释放旧项',
  })).status).toBe(200)
  const afterRelease = await s.read()
  expect((await s.batch({ ...s.input, expectedReservationFingerprint: addedFingerprint })).status).toBe(409)
  expect(await s.read()).toEqual(afterRelease)
  const reviewed = await s.batch({ ...s.input,
    expectedReservationFingerprint: afterRelease.reservationSets.find(set => set.requestId === s.input.requestId)!.fingerprint })
  expect(reviewed.status).toBe(200)
  expect(responseSchema.parse(await reviewed.json()).data.reservations.filter(item => item.status === 'reserved')).toHaveLength(2)
})

it('第二项存储失败时回滚新预留及旧预留释放，同意图修复后可恢复', async () => {
  const s = await setupBatch()
  const first = responseSchema.parse(await (await s.batch()).json()).data
  const input = { ...s.input, expectedReservationFingerprint: first.reservationSets.find(set => set.requestId === s.input.requestId)!.fingerprint }
  const key = randomUUID()
  s.runtime.database.driver.exec(`CREATE TRIGGER synthetic_batch_failure BEFORE INSERT ON inpatient_material_reservation
    WHEN NEW.material_id='hospital-material-guidewire' BEGIN SELECT RAISE(ABORT,'Synthetic reservation storage unavailable'); END`)
  expect((await s.batch(input, key)).status).toBe(500)
  expect(await s.read()).toEqual(first)
  const fees = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
  expect(fees.chargesFen).toBe(0)
  s.runtime.database.driver.exec('DROP TRIGGER synthetic_batch_failure')
  const recovered = await s.batch(input, key)
  expect(recovered.status).toBe(200)
  const saved = responseSchema.parse(await recovered.json()).data
  expect(saved.reservations.filter(item => item.status === 'reserved')).toHaveLength(2)
  expect(saved.reservations.filter(item => item.status === 'released')).toHaveLength(2)
})

it('重复确认与丢回执恢复复用同一结果，同库重启不叠加预留', async () => {
  const s = await setupBatch(), key = randomUUID()
  const first = await s.batch(s.input, key)
  expect(first.status).toBe(200)
  const saved = responseSchema.parse(await first.json())
  const replay = responseSchema.parse(await (await s.batch(s.input, key)).json())
  expect(replay).toEqual(saved)
  expect((await s.batch()).status).toBe(409)
  const changedIntent = await s.batch({ ...s.input, reason: '不能用同一幂等键更换审阅内容' }, key)
  expect(changedIntent.status).toBe(409)
  expect(apiErrorSchema.parse(await changedIntent.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  await s.restart()
  const receipt = await s.request(s.doctor, `/api/his/v1/command-receipts?operationId=inpatient.drg.reservation.replace-batch&idempotencyKey=${key}`)
  expect(receipt.status).toBe(200)
  expect(await receipt.json()).toMatchObject({ status: 'completed', response: saved })
  expect(responseSchema.parse(await (await s.batch(s.input, key)).json())).toEqual(saved)
  expect(await s.read()).toEqual(saved.data)
})

it('失权、已取消或已开始的计划不能整批确认，已有材料使用保持原样', async () => {
  const s = await setupBatch()
  expect((await s.request(s.nurse, `${s.path}/drg/reservations/replace-batch`, s.input)).status).toBe(403)
  const reserved = responseSchema.parse(await (await s.batch()).json()).data
  const expectedReservationFingerprint = reserved.reservationSets.find(set => set.requestId === s.input.requestId)!.fingerprint
  const prepared = await s.request(s.nurse, `${s.path}/surgeries/check-preop`, {
    requestId: s.input.requestId, expectedRequestVersion: 1, note: '合成术前核查' })
  expect(prepared.status).toBe(200)
  const consent = await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, {
    requestId: s.input.requestId, expectedRequestVersion: 2, note: '合成知情同意' })
  expect(consent.status).toBe(200)
  const started = await s.request(s.doctor, `${s.path}/surgeries/start`, {
    requestId: s.input.requestId, expectedRequestVersion: 3, procedureId: 'hospital-surgery-8', catalogVersion: 1, note: '合成造影开始' })
  expect(started.status).toBe(200)
  let surgery = inpatientSurgeryResponseSchema.parse(await started.json()).data
  const recorded = await s.request(s.doctor, `${s.path}/surgeries/record-material`, {
    requestId: s.input.requestId, expectedRequestVersion: surgery.requests[0]!.version, executionId: surgery.inProgress[0]!.id,
    material: { materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 1,
      reservationId: reserved.reservations[0]!.id, expectedReservationVersion: reserved.reservations[0]!.version }, note: '合成部分使用一根导管' })
  expect(recorded.status).toBe(200)
  surgery = inpatientSurgeryResponseSchema.parse(await recorded.json()).data
  const before = await s.read()
  const rejected = await s.batch({ ...s.input, expectedReservationFingerprint, expectedRequestVersion: surgery.requests[0]!.version })
  expect(rejected.status).toBe(409)
  expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('INPATIENT_SURGERY_IN_PROGRESS')
  expect(await s.read()).toEqual(before)
  expect(inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())).toEqual(surgery)

  const other = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: surgery.encounterVersion,
    procedureId: 'hospital-surgery-7', catalogVersion: 1, plannedFor: surgery.virtualTime, reason: '另一个已撤销合成造影计划' })
  const otherPlan = inpatientSurgeryResponseSchema.parse(await other.json()).data.requests.find(item => item.id !== s.input.requestId)!
  expect((await s.request(s.doctor, `${s.path}/surgeries/cancel`, {
    requestId: otherPlan.id, expectedRequestVersion: otherPlan.version, note: '临床计划调整' })).status).toBe(200)
  const cancelled = await s.batch({ ...s.input, requestId: otherPlan.id, expectedRequestVersion: otherPlan.version + 1 })
  expect(cancelled.status).toBe(409)
  expect(apiErrorSchema.parse(await cancelled.json()).error.code).toBe('INPATIENT_SURGERY_CONFLICT')
  expect((await s.read()).reservations).toEqual(before.reservations)
})

it('逐项金额与整批总额都限制在安全整数范围', async () => {
  const s = await setupBatch()
  const before = await s.read()
  s.runtime.database.driver.exec(`UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.priceFen',5000000000000000)
    WHERE item_id IN ('hospital-material-catheter','hospital-material-guidewire')`)
  for (const items of [s.input.items, s.input.items.map(item => ({ ...item, quantity: 1 }))]) {
    const rejected = await s.batch({ ...s.input, items })
    expect(rejected.status).toBe(409)
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('INPATIENT_RESERVATION_AMOUNT_INVALID')
    expect(await s.read()).toEqual(before)
  }
})
