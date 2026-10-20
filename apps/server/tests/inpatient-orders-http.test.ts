import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-orders-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const runtime = await createClinMeshRuntime({ authBaseUrl: 'http://localhost',
    authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'hospital.sqlite'), demoPassword: password, migrationMode: 'apply', trustedOrigins: ['http://localhost'] })
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key = randomUUID()) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  }
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse')
  const pharmacist = await login('pharmacist'), cashier = await login('cashier'), admin = await login('admin')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar,
    origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {},
    input: { name: '合成医嘱患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  const patient = (await created.json()).data.patient
  const registered = inpatientCommandResponseSchema.parse(await (await request(registrar, '/api/his/v1/inpatient/admissions', {
    expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const admission = inpatientCommandResponseSchema.parse(await (await request(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1' })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  return { runtime, request, login, patient, admission, path, doctor, nurse, pharmacist, cashier, admin, registrar }
}

describe('住院医嘱 HTTP 与真实 SQLite 合同', () => {
  it('住院医生确认真实目录诊断形成本次Condition及Encounter诊断，拒绝非医生和无效目录', async () => {
    const s = await setup()
    const input = { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-type-2-diabetes', role: 'primary' }] }
    const catalog = await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')
    expect(catalog.status).toBe(200)
    const diagnoses = (await catalog.json()).diagnoses
    const diabetes = diagnoses.find((d: { code: string }) => d.code === 'E11.65')
    expect(diabetes).toBeDefined()
    input.entries[0]!.catalogItemId = diabetes.id
    expect((await s.request(s.nurse, `${s.path}/diagnoses/confirm`, input)).status).toBe(403)
    expect((await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { ...input, entries: [{ catalogItemId: 'missing', role: 'primary' }] })).status).toBe(409)
    const key = randomUUID()
    const response = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, input, key)
    expect(response.status).toBe(200)
    const confirmed = await response.json()
    expect((await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, input, key)).json())).toEqual(confirmed)
    const conditions = fhirBundleSchema.parse(await (await s.request(s.doctor, `/fhir/R5/Condition?encounter=Encounter/${s.admission.id}&_total=accurate`)).json())
    expect(conditions.total).toBe(1)
    expect(conditions.entry![0]!.resource).toMatchObject({ subject: { reference: `Patient/${s.patient.id}` },
      verificationStatus: { coding: [{ code: 'confirmed' }] }, code: { coding: [{ code: 'E11.65' }] } })
    const encounter = fhirResourceSchema.parse(await (await s.request(s.doctor, `/fhir/R5/Encounter/${s.admission.id}`)).json())
    expect(JSON.stringify(encounter.diagnosis)).toContain(`Condition/${conditions.entry![0]!.resource.id}`)
  })
  it('真实药品校验每次片数和适应症，校对后按BID首日及跨日展开，停嘱冻结任务', async () => {
    const s = await setup()
    const issue = { encounterVersion: s.admission.versionId, duration: 'long', selection: { kind: 'medication',
      catalogItemId: 'medication-metformin', catalogVersion: 1, doseText: '0.5 g', frequencyCode: 'BID', doseQuantity: 1 } }
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, issue)).status).toBe(409)
    const diagnosis = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia', role: 'primary' }] })
    expect(diagnosis.status).toBe(200)
    issue.encounterVersion = (await diagnosis.json()).data.encounterVersion
    for (const selection of [{ ...issue.selection, catalogItemId: 'missing' }, { ...issue.selection, doseText: '500 g' },
      { ...issue.selection, frequencyCode: 'TID' }, { ...issue.selection, doseQuantity: 60 }, { ...issue.selection, catalogVersion: 999 },
      { ...issue.selection, catalogItemId: 'medication-amlodipine', doseText: '5 mg', frequencyCode: 'QD' }]) {
      const invalid = await s.request(s.doctor, `${s.path}/orders/issue`, { ...issue, selection })
      expect(invalid.status).toBe(selection.frequencyCode === 'TID' ? 400 : 409)
      expect((await invalid.json()).error.code).toBe(selection.frequencyCode === 'TID' ? 'INVALID_INPUT' : 'CATALOG_CONFLICT')
    }
    const response = await s.request(s.doctor, `${s.path}/orders/issue`, issue)
    expect(response.status).toBe(200)
    const initial = (await response.json()).data
    const order = initial.orders[0]
    expect(order).toMatchObject({ state: 'signed', doseQuantity: 1, frequencyCode: 'BID' })
    expect(initial.executions).toEqual([])
    expect((await s.request(s.pharmacist, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).status).toBe(403)
    const verified = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })
    expect(verified.status).toBe(200)
    const checked = (await verified.json()).data
    expect(checked.executions.map((e: { scheduledFor: string }) => e.scheduledFor)).toEqual(['2026-08-24T12:00:00.000Z'])
    const clock = await (await s.request(s.admin, '/api/sim/v1/scenario-runs/current')).json()
    const next = '2026-08-25T01:00:00.000Z'
    expect((await s.request(s.admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: clock.virtualTime, targetVirtualTime: next })).status).toBe(200)
    const after = await (await s.request(s.doctor, `${s.path}/clinical`)).json()
    expect(after.executions).toHaveLength(3)
    expect(after.executions.map((e: { scheduledFor: string }) => e.scheduledFor)).toContain('2026-08-25T00:00:00.000Z')
    const stopped = await s.request(s.doctor, `${s.path}/orders/request-stop`, { orderId: order.id, expectedOrderVersion: checked.orders[0].version, reason: '调整治疗' })
    expect(stopped.status).toBe(200)
    const stop = (await stopped.json()).data.orders[0]
    expect((await s.request(s.nurse, `${s.path}/orders/verify-stop`, { orderId: order.id, expectedOrderVersion: stop.version })).status).toBe(200)
    expect((await s.request(s.admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: next, targetVirtualTime: '2026-08-26T01:00:00.000Z' })).status).toBe(200)
    const final = await (await s.request(s.doctor, `${s.path}/clinical`)).json()
    expect(final.executions).toHaveLength(3)
    expect(final.executions.every((e: { status: string }) => e.status === 'cancelled')).toBe(true)
  })

  it('临时医嘱实际发药扣共享库存并产生逐项费用，未发药不能给药，重试不会重复消耗', async () => {
    const s = await setup()
    const diagnosis = await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary' }] })).json()
    const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: diagnosis.data.encounterVersion, duration: 'temporary',
      selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })
    expect(issued.status).toBe(200)
    const order = (await issued.json()).data.orders[0]
    const verified = await (await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).json()
    const execution = verified.data.executions[0]
    expect((await s.request(s.nurse, `${s.path}/executions/administer`, { executionId: execution.id, expectedExecutionVersion: execution.version })).status).toBe(409)
    const catalog = await (await s.request(s.pharmacist, '/api/his/v1/inpatient/clinical-catalog')).json()
    const medication = catalog.medications.find((m: { id: string }) => m.id === 'medication-amlodipine')
    const lot = medication.lots[0]
    const input = { executionId: execution.id, expectedExecutionVersion: execution.version, lotSelections: [{ lotId: lot.id, expectedVersion: 999, quantity: 1 }] }
    expect((await s.request(s.pharmacist, `${s.path}/executions/dispense`, input)).status).toBe(409)
    expect((await (await s.request(s.doctor, `${s.path}/clinical`)).json()).charges).toEqual([])
    input.lotSelections[0]!.expectedVersion = lot.version
    const key = randomUUID()
    const supplied = await s.request(s.pharmacist, `${s.path}/executions/dispense`, input, key)
    expect(supplied.status).toBe(200)
    const dispensed = await supplied.json()
    expect(await (await s.request(s.pharmacist, `${s.path}/executions/dispense`, input, key)).json()).toEqual(dispensed)
    expect(dispensed.data.dispenses).toHaveLength(1)
    expect(dispensed.data.charges).toMatchObject([{ kind: 'medication', amountFen: medication.priceFen }])
    const inventory = fhirResourceSchema.parse(await (await s.request(s.pharmacist, `/fhir/R5/InventoryItem/${lot.id}`)).json())
    expect(inventory).toMatchObject({ meta: { versionId: String(lot.version + 1) }, netContent: { value: lot.quantityOnHand - 1 } })
    expect((await s.request(s.pharmacist, `${s.path}/executions/dispense`, input)).status).toBe(409)
    const dose = { executionId: execution.id, expectedExecutionVersion: dispensed.data.executions[0].version }
    const administerKey = randomUUID()
    const administered = await s.request(s.nurse, `${s.path}/executions/administer`, dose, administerKey)
    expect(administered.status).toBe(200)
    expect(await (await s.request(s.nurse, `${s.path}/executions/administer`, dose, administerKey)).json()).toEqual(await administered.json())
    const administrations = fhirBundleSchema.parse(await (await s.request(s.doctor, `/fhir/R5/MedicationAdministration?encounter=Encounter/${s.admission.id}&_total=accurate`)).json())
    expect(administrations.total).toBe(1)
    expect(administrations.entry![0]!.resource).toMatchObject({ status: 'completed', medication: { reference: { reference: 'Medication/medication-amlodipine' } },
      request: { reference: `MedicationRequest/${order.id}` }, partOf: [{ reference: `MedicationDispense/${dispensed.data.dispenses[0].id}` }],
      occurenceDateTime: expect.any(String), performer: [{ actor: { reference: { reference: 'PractitionerRole/practitioner-role-ward-nurse' } } }] })
    const audit = await (await s.request(s.admin, '/fhir/R5/AuditEvent?_count=100')).json()
    expect(JSON.stringify(audit)).toContain('inpatient.execution.dispense')
    expect(JSON.stringify(audit)).toContain('inpatient.execution.administer')
  })

  it('实际健康教育服务执行后计费，不能用通用执行绕过检查检验', async () => {
    const s = await setup()
    const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: s.admission.versionId, duration: 'temporary',
      selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } })
    expect(issued.status).toBe(200)
    const order = (await issued.json()).data.orders[0]
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: s.admission.versionId, duration: 'temporary',
      selection: { kind: 'service', serviceId: 'hospital-service-cbc', serviceVersion: 1, quantity: 1 } })).status).toBe(409)
    const verified = await (await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).json()
    const execution = verified.data.executions[0]
    const input = { executionId: execution.id, expectedExecutionVersion: execution.version }
    const key = randomUUID()
    const response = await s.request(s.nurse, `${s.path}/executions/complete`, input, key)
    expect(response.status).toBe(200)
    const completed = await response.json()
    expect(completed.data.charges).toMatchObject([{ kind: 'service', amountFen: 3000, sourceId: execution.id }])
    expect(completed.data.orders[0].state).toBe('completed')
    expect(await (await s.request(s.nurse, `${s.path}/executions/complete`, input, key)).json()).toEqual(completed)
  })

  it('冲正只能由收费员关联原费用全额反记，重试不重复且非法逆向不改账', async () => {
    const s = await setup()
    const clock = await (await s.request(s.admin, '/api/sim/v1/scenario-runs/current')).json()
    expect((await s.request(s.admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: clock.virtualTime, targetVirtualTime: '2026-08-25T01:00:00.000Z' })).status).toBe(200)
    const ledger = await (await s.request(s.cashier, `${s.path}/clinical`)).json()
    const charge = ledger.charges[0]
    const input = { chargeId: charge.id, expectedChargeVersion: charge.version, reason: '合成费用纠错' }
    expect((await s.request(s.nurse, `${s.path}/charges/reverse`, input)).status).toBe(403)
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, { ...input, expectedChargeVersion: 999 })).status).toBe(409)
    const key = randomUUID()
    const response = await s.request(s.cashier, `${s.path}/charges/reverse`, input, key)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.data.chargesFen).toBe(0)
    expect(result.data.charges).toHaveLength(2)
    expect(result.data.charges.find((c: { id: string }) => c.id === charge.id)).toEqual(charge)
    expect(result.data.charges.find((c: { reversalOf?: string }) => c.reversalOf === charge.id)).toMatchObject({ amountFen: -5000, reason: '合成费用纠错' })
    expect(await (await s.request(s.cashier, `${s.path}/charges/reverse`, input, key)).json()).toEqual(result)
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, input)).status).toBe(409)
    const inverse = result.data.charges.find((c: { reversalOf?: string }) => c.reversalOf === charge.id)
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, { ...input, chargeId: inverse.id })).status).toBe(409)
    expect((await (await s.request(s.cashier, `${s.path}/clinical`)).json()).chargesFen).toBe(0)
  })

  it('PRN只由护士按已校对医嘱和理由显式创建，午夜不自动展开且停嘱立即拒绝新任务', async () => {
    const s = await setup()
    const diagnosed = await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-fever', role: 'primary' }] })).json()
    const issued = await (await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: diagnosed.data.encounterVersion, duration: 'long',
      selection: { kind: 'medication', catalogItemId: 'medication-acetaminophen', catalogVersion: 1, doseText: '0.5 g', doseQuantity: 1, frequencyCode: 'PRN' } })).json()
    const order = issued.data.orders[0]
    const input = { orderId: order.id, expectedOrderVersion: order.version, reason: '合成患者发热不适' }
    expect((await s.request(s.nurse, `${s.path}/executions/request-prn`, input)).status).toBe(409)
    const verified = await (await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).json()
    expect(verified.data.executions).toEqual([])
    input.expectedOrderVersion = verified.data.orders[0].version
    expect((await s.request(s.doctor, `${s.path}/executions/request-prn`, input)).status).toBe(403)
    const key = randomUUID()
    const requested = await s.request(s.nurse, `${s.path}/executions/request-prn`, input, key)
    expect(requested.status).toBe(200)
    const created = await requested.json()
    expect(created.data.executions).toMatchObject([{ reason: '合成患者发热不适', status: 'pending' }])
    expect(await (await s.request(s.nurse, `${s.path}/executions/request-prn`, input, key)).json()).toEqual(created)
    const clock = await (await s.request(s.admin, '/api/sim/v1/scenario-runs/current')).json()
    expect((await s.request(s.admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: clock.virtualTime, targetVirtualTime: '2026-08-25T01:00:00.000Z' })).status).toBe(200)
    expect((await (await s.request(s.doctor, `${s.path}/clinical`)).json()).executions).toHaveLength(1)
    const stop = await s.request(s.doctor, `${s.path}/orders/request-stop`, { ...input, reason: '调整治疗' })
    expect(stop.status).toBe(200)
    input.expectedOrderVersion = (await stop.json()).data.orders[0].version
    expect((await s.request(s.nurse, `${s.path}/executions/request-prn`, input)).status).toBe(409)
  })

})
