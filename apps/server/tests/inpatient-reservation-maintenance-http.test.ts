import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { apiErrorSchema, commandResponseSchema, createPatientResponseSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { setupDrgReview } from './fixtures/inpatient-drg-review.ts'

const responseSchema = commandResponseSchema(inpatientMaterialReservationListSchema)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setupMaintenance() {
  const s = await setupDrgReview(cleanups)
  const initial = inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())
  const planned = await s.request(s.doctor, `${s.path}/surgeries/request`, {
    encounterVersion: initial.encounterVersion, procedureId: 'hospital-surgery-8', catalogVersion: 1,
    plannedFor: initial.virtualTime, reason: '合成手工预留维护计划',
  })
  expect(planned.status).toBe(200)
  const surgery = inpatientSurgeryResponseSchema.parse(await planned.json()).data
  const requestId = surgery.requests[0]!.id
  const input = { encounterVersion: surgery.encounterVersion, requestId,
    materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 3, reason: '合成医生审阅计划用量' }
  const read = async () => inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
  const create = (value: unknown = input, key = randomUUID()) => s.request(s.doctor, `${s.path}/drg/reservations`, value, key)
  const release = (reservationId: string, value: unknown, key = randomUUID()) =>
    s.request(s.doctor, `${s.path}/drg/reservations/${reservationId}/release`, value, key)
  const successfulAudits = async (operation: string) => {
    const response = await s.request(s.doctor, '/fhir/R5/AuditEvent?_total=accurate&_count=100')
    expect(response.status).toBe(200)
    const bundle = fhirBundleSchema.parse(await response.json())
    const auditSchema = z.object({ id: z.string(), code: z.object({ text: z.string() }),
      outcome: z.object({ code: z.object({ code: z.string() }) }) })
    return (bundle.entry ?? []).map(entry => auditSchema.parse(entry.resource))
      .filter(audit => audit.code.text === operation && audit.outcome.code.code === '0')
  }
  const assertNoClinicalEffects = async () => {
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges).toEqual([])
    const procedures = await s.request(s.doctor, `/fhir/R5/Procedure?encounter=Encounter/${s.admission.id}&_total=accurate`)
    expect(procedures.status).toBe(200)
    expect(fhirBundleSchema.parse(await procedures.json()).total).toBe(0)
  }
  return { ...s, requestId, input, read, create, release, successfulAudits, assertNoClinicalEffects }
}

it('同一计划两次独立创建逐项成功，不产生实际材料费用或Procedure', async () => {
  const s = await setupMaintenance()
  const first = await s.create()
  expect(first.status).toBe(200)
  const firstSaved = responseSchema.parse(await first.json())
  const second = await s.create({ ...s.input, materialId: 'hospital-material-guidewire', quantity: 2, reason: '合成备用导丝单独审阅' })
  expect(second.status).toBe(200)
  const saved = responseSchema.parse(await second.json())
  expect(saved.auditId).not.toBe(firstSaved.auditId)
  expect(saved.data.reservations).toHaveLength(2)
  expect(saved.data.reservations.find(item => item.id === firstSaved.data.reservations[0]!.id)).toEqual(firstSaved.data.reservations[0])
  expect(saved.data.reservations).toEqual(expect.arrayContaining([
    expect.objectContaining({ requestId: s.requestId, materialId: 'hospital-material-catheter', quantity: 3, status: 'reserved' }),
    expect.objectContaining({ requestId: s.requestId, materialId: 'hospital-material-guidewire', quantity: 2, status: 'reserved' }),
  ]))
  expect(await s.read()).toEqual(saved.data)
  expect(await s.successfulAudits('inpatient.drg.reservation.create')).toHaveLength(2)
  await s.assertNoClinicalEffects()
})

it('第二项真实目录冲突独立失败，第一项成功保留且无费用或Procedure', async () => {
  const s = await setupMaintenance()
  const first = responseSchema.parse(await (await s.create()).json())
  const second = await s.create({ ...s.input, materialId: 'hospital-material-guidewire', catalogVersion: 99 })
  expect(second.status).toBe(409)
  expect(apiErrorSchema.parse(await second.json()).error.code).toBe('CATALOG_CONFLICT')
  expect(await s.read()).toEqual(first.data)
  expect(await s.successfulAudits('inpatient.drg.reservation.create')).toHaveLength(1)
  await s.assertNoClinicalEffects()
})

it('两次独立释放中第二项审阅已失效，第一项成功与第三条未选预留保持', async () => {
  const s = await setupMaintenance()
  for (const materialId of ['hospital-material-catheter', 'hospital-material-guidewire', 'hospital-material-balloon'])
    expect((await s.create({ ...s.input, materialId })).status).toBe(200)
  const reviewed = await s.read()
  const [first, second, unselected] = reviewed.reservations
  const releaseInput = { encounterVersion: reviewed.encounterVersion, expectedReservationVersion: 1, reason: '合成逐项审阅后释放' }
  expect((await s.release(second!.id, releaseInput)).status).toBe(200)
  const firstResult = await s.release(first!.id, releaseInput)
  expect(firstResult.status).toBe(200)
  const saved = responseSchema.parse(await firstResult.json()).data
  const stale = await s.release(second!.id, releaseInput)
  expect(stale.status).toBe(409)
  expect(apiErrorSchema.parse(await stale.json()).error).toMatchObject({ code: 'INPATIENT_RESERVATION_CONFLICT', reason: 'RESERVATION_NOT_RELEASABLE' })
  expect(await s.read()).toEqual(saved)
  expect(saved.reservations.find(item => item.id === first!.id)).toMatchObject({ status: 'released', version: 2 })
  expect(saved.reservations.find(item => item.id === unselected!.id)).toEqual(unselected)
  expect(await s.successfulAudits('inpatient.drg.reservation.release')).toHaveLength(2)
  await s.assertNoClinicalEffects()
})

it('创建及释放丢响应后原键恢复跨重启保持同一回执、预留和成功审计，旧单条释放仍兼容', async () => {
  const s = await setupMaintenance(), createKey = randomUUID(), releaseKey = randomUUID()
  const created = await s.create(s.input, createKey)
  expect(created.status).toBe(200)
  const original = responseSchema.parse(await created.json())
  const reservation = original.data.reservations[0]!
  const legacyInput = { encounterVersion: original.data.encounterVersion, reason: '合成旧单条释放兼容' }
  const released = await s.release(reservation.id, legacyInput, releaseKey)
  expect(released.status).toBe(200)
  const saved = responseSchema.parse(await released.json())
  await s.restart()
  for (const [operation, key, expected] of [
    ['inpatient.drg.reservation.create', createKey, original], ['inpatient.drg.reservation.release', releaseKey, saved],
  ] as const) {
    const receipt = await s.request(s.doctor, `/api/his/v1/command-receipts?operationId=${operation}&idempotencyKey=${key}`)
    expect(receipt.status).toBe(200)
    expect(commandReceiptLookupSchema.parse(await receipt.json())).toMatchObject({ status: 'completed', response: expected })
    expect(await s.successfulAudits(operation)).toHaveLength(1)
  }
  expect(responseSchema.parse(await (await s.create(s.input, createKey)).json())).toEqual(original)
  expect(responseSchema.parse(await (await s.release(reservation.id, legacyInput, releaseKey)).json())).toEqual(saved)
  const changed = await s.release(reservation.id, { ...legacyInput, expectedReservationVersion: reservation.version }, releaseKey)
  expect(changed.status).toBe(409)
  expect(apiErrorSchema.parse(await changed.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  expect(await s.read()).toEqual(saved.data)
  for (const operation of ['inpatient.drg.reservation.create', 'inpatient.drg.reservation.release'])
    expect(await s.successfulAudits(operation)).toHaveLength(1)
  await s.assertNoClinicalEffects()
})

it('跨患者引用与非医生释放被拒绝，原患者预留不变', async () => {
  const s = await setupMaintenance()
  const saved = responseSchema.parse(await (await s.create()).json()).data
  const reservation = saved.reservations[0]!
  const created = await s.runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: {
    cookie: s.registrar, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID(),
  }, body: JSON.stringify({ expectedVersions: {}, input: {
    name: '合成另一预留患者', gender: 'female', birthDate: '1970-04-05', identifier: `SYN-${randomUUID()}`,
  } }) })
  expect(created.status).toBe(200)
  const patient = createPatientResponseSchema.parse(await created.json()).data.patient
  const registered = await s.request(s.registrar, '/api/his/v1/inpatient/admissions', {
    expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct',
    wardId: 'ward-general', depositFen: 100000,
  })
  expect(registered.status).toBe(200)
  const registration = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
  const received = await s.request(s.nurse, `/api/his/v1/inpatient/admissions/${registration.id}/receive`, {
    encounterVersion: registration.versionId, bedId: 'bed-general-2',
  })
  expect(received.status).toBe(200)
  const other = inpatientCommandResponseSchema.parse(await received.json()).data.admission
  const releaseInput = { encounterVersion: other.versionId, expectedReservationVersion: reservation.version, reason: '合成越界释放应拒绝' }
  const crossPatient = await s.request(s.doctor,
    `/api/his/v1/inpatient/admissions/${other.id}/drg/reservations/${reservation.id}/release`, releaseInput)
  expect(crossPatient.status).toBe(404)
  expect(apiErrorSchema.parse(await crossPatient.json()).error.code).toBe('INPATIENT_RESERVATION_NOT_FOUND')
  const crossPlan = await s.request(s.doctor, `/api/his/v1/inpatient/admissions/${other.id}/drg/reservations`, {
    ...s.input, encounterVersion: other.versionId,
  })
  expect(crossPlan.status).toBe(404)
  const forbidden = await s.request(s.nurse, `${s.path}/drg/reservations/${reservation.id}/release`, {
    ...releaseInput, encounterVersion: saved.encounterVersion,
  })
  expect(forbidden.status).toBe(403)
  expect(await s.read()).toEqual(saved)
  expect(await s.successfulAudits('inpatient.drg.reservation.release')).toEqual([])
})

it('审阅后部分使用改变预留版本，旧版本拒绝释放，重新审阅只释放剩余数量且不改实际收费', async () => {
  const s = await setupMaintenance()
  const created = await s.create()
  expect(created.status).toBe(200)
  const reviewed = responseSchema.parse(await created.json()).data.reservations[0]!
  for (const [cookie, action, expectedRequestVersion] of [
    [s.nurse, 'check-preop', 1], [s.doctor, 'confirm-consent', 2],
  ] as const) {
    expect((await s.request(cookie, `${s.path}/surgeries/${action}`, {
      requestId: s.requestId, expectedRequestVersion, note: '合成术前准备确认',
    })).status).toBe(200)
  }
  const started = await s.request(s.doctor, `${s.path}/surgeries/start`, {
    requestId: s.requestId, expectedRequestVersion: 3, procedureId: 'hospital-surgery-8', catalogVersion: 1, note: '合成开始手术',
  })
  expect(started.status).toBe(200)
  const surgery = inpatientSurgeryResponseSchema.parse(await started.json()).data
  const used = await s.request(s.doctor, `${s.path}/surgeries/record-material`, {
    requestId: s.requestId, expectedRequestVersion: surgery.requests[0]!.version, executionId: surgery.inProgress[0]!.id,
    material: { materialId: reviewed.materialId, catalogVersion: 1, quantity: 1,
      reservationId: reviewed.id, expectedReservationVersion: reviewed.version }, note: '合成部分使用一根',
  })
  expect(used.status).toBe(200)
  const before = await s.read()
  const current = before.reservations[0]!
  expect(current).toMatchObject({ version: reviewed.version + 1, consumedQuantity: 1, remainingQuantity: 2, status: 'reserved' })
  const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
  expect(charges.chargesFen).toBe(5000)
  const release = { encounterVersion: before.encounterVersion, expectedReservationVersion: reviewed.version, reason: '合成释放不再使用的余量' }
  const stale = await s.release(reviewed.id, release)
  expect(stale.status).toBe(409)
  expect(apiErrorSchema.parse(await stale.json()).error).toMatchObject({ code: 'INPATIENT_RESERVATION_CONFLICT', reason: 'RESERVATION_REMAINDER_CHANGED' })
  expect(await s.read()).toEqual(before)
  const saved = await s.release(reviewed.id, { ...release, expectedReservationVersion: current.version })
  expect(saved.status).toBe(200)
  expect(responseSchema.parse(await saved.json()).data.reservations[0]).toMatchObject({
    id: reviewed.id, quantity: 3, consumedQuantity: 1, remainingQuantity: 0, status: 'released', version: current.version + 1,
  })
  expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())).toEqual(charges)
})
