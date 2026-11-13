import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'
import { isRetiredCapturedPaymentTable, prePaymentCutoverMigrations } from './fixtures/historical-payment-schema.ts'
import { serviceCatalogSearchSchema } from '@clinmesh/contracts/his'
import type { ReferenceConcept } from '@clinmesh/contracts/reference-data'
import { applyMigrations, canonicalStateHash, expectedSchemaVersion, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { dispenseResponseSchema, prescriptionReviewResponseSchema, pharmacyQueueSchema, registrationResponseSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { inpatientPharmacySchema, inpatientPharmacyListSchema, inpatientPharmacyResponseSchema, inpatientChargesSchema, inpatientChargesResponseSchema, inpatientFullCatalogSchema, inpatientFullClinicalSchema, inpatientFullClinicalResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { scenarioStateSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, mkdir, readdir, copyFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { laboratoryServiceSnapshotSchema } from '@clinmesh/contracts/his'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup(withReference = false, extraConcepts: ReferenceConcept[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-orders-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  if (withReference) {
    const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
      system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成真实目录高血压', status: 'active', sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457' }, ...extraConcepts],
      medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
    await writeFile(join(directory,'reference.json'),artifact)
    await writeFile(join(directory,'release.json'),JSON.stringify({ releaseId: 'synthetic-clinical-2022', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z',
      sources: [{ sourceId: 'synthetic-clinical', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'CC0-1.0',
        retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
    await runReferenceDatabaseCli(['migrate','--database',referenceDatabasePath])
    await runReferenceDatabaseCli(['import','--database',referenceDatabasePath,'--manifest',join(directory,'release.json')])
  }
  const openRuntime = () => createClinMeshRuntime({ authBaseUrl: 'http://localhost',
    authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'hospital.sqlite'), ...(withReference ? { referenceDatabasePath, activeReferenceReleaseId: 'synthetic-clinical-2022' } : {}), demoPassword: password, migrationMode: 'apply', trustedOrigins: ['http://localhost'] })
  let runtime = await openRuntime()
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key = randomUUID()) {
    const response = await runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
    if(response.ok && path.includes('/inpatient/')) {
      const value=await response.clone().json()
      if(path.endsWith('/clinical-catalog')) inpatientFullCatalogSchema.parse(value)
      else if(path.endsWith('/clinical')) inpatientFullClinicalSchema.parse(value)
      else if(path.endsWith('/pharmacy/admissions')) inpatientPharmacyListSchema.parse(value)
      else if(path.endsWith('/pharmacy')) inpatientPharmacySchema.parse(value)
      else if(path.endsWith('/charges')) inpatientChargesSchema.parse(value)
      else if(path.endsWith('/executions/dispense')) inpatientPharmacyResponseSchema.parse(value)
      else if(path.endsWith('/charges/reverse')) inpatientChargesResponseSchema.parse(value)
      else if(/\/(orders|executions|diagnoses|charges)\//.test(path)) inpatientFullClinicalResponseSchema.parse(value)
    }
    return response
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
  return { get runtime() { return runtime }, request, login, patient, admission, path, doctor, nurse, pharmacist, cashier, admin, registrar, directory, password, databasePath:join(directory,'hospital.sqlite'),
    restart: async () => { await runtime.close(); runtime = await openRuntime() } }
}

async function pendingBidDispenses() {
  const s = await setup()
  const diagnosed = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
    encounterVersion: s.admission.versionId, expectedRevision: 0,
    entries: [{ catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia', role: 'primary', admissionCondition: '1' }],
  })).json()).data
  const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: diagnosed.encounterVersion, duration: 'long',
    selection: { kind: 'medication', catalogItemId: 'medication-metformin', catalogVersion: 1, doseText: '0.5 g', doseQuantity: 1, frequencyCode: 'BID' } })
  expect(issued.status, await issued.clone().text()).toBe(200)
  const order = inpatientFullClinicalResponseSchema.parse(await issued.json()).data.orders[0]!
  expect((await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).status).toBe(200)
  const clock = scenarioStateSchema.parse(await (await s.request(s.admin, '/api/sim/v1/scenario-runs/current')).json())
  expect((await s.request(s.admin, `/api/sim/v1/scenario-runs/${clock.scenarioRunId}/actions/advance-time`, {
    expectedVirtualTime: clock.virtualTime, targetVirtualTime: '2026-08-25T01:00:00.000Z',
  })).status).toBe(200)
  const pharmacy = inpatientPharmacySchema.parse(await (await s.request(s.pharmacist, `${s.path}/pharmacy`)).json())
  expect(pharmacy.executions).toHaveLength(3)
  expect(new Set(pharmacy.executions.map(item => item.scheduledFor)).size).toBe(3)
  expect(pharmacy.executions.every(item => item.orderId === order.id && item.status === 'pending')).toBe(true)
  const medication = inpatientFullCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json())
    .medications.find(item => item.id === order.catalogItemId)!
  const lot = pharmacy.medications.find(item => item.id === order.catalogItemId)!.lots[0]!
  const input = (index: number, expectedVersion: number) => ({ executionId: pharmacy.executions[index]!.id,
    expectedExecutionVersion: pharmacy.executions[index]!.version, lotSelections: [{ lotId: lot.id, expectedVersion, quantity: 1 }] })
  const facts = async () => ({
    pharmacy: inpatientPharmacySchema.parse(await (await s.request(s.pharmacist, `${s.path}/pharmacy`)).json()),
    inventory: fhirResourceSchema.parse(await (await s.request(s.pharmacist, `/fhir/R5/InventoryItem/${lot.id}`)).json()),
    charges: inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()),
  })
  return { s, pharmacy, order, medication, lot, input, facts }
}

// 存量已支付处方 fixture；不将其作为门诊诊疗闭环的验收证据。
async function paidOutpatient(s: Awaited<ReturnType<typeof setup>>) {
  const registration=await s.runtime.app.request('/api/his/v1/registrations/actions/register',{method:'POST',headers:{cookie:s.registrar,origin:'http://localhost','content-type':'application/json','idempotency-key':randomUUID()},
    body:JSON.stringify({expectedVersions:{[`Patient/${s.patient.id}`]:s.patient.versionId},input:{patientId:s.patient.id,departmentId:'department-general-medicine',locationId:'location-outpatient',visitDate:'2026-08-24',visitTypeId:'visit-general'}})})
  const encounterId=registrationResponseSchema.parse(await registration.json()).data.encounterId
  const context=sessionContextSchema.parse(await(await s.request(s.admin,'/api/auth/context')).json()).actor
  const db=s.runtime.database.driver,caseId=z.object({case_id:z.string()}).parse(db.prepare('SELECT case_id FROM outpatient_case WHERE encounter_id=? AND workspace_id=? AND epoch=?').get(encounterId,context.workspaceId,context.epoch)).case_id
  const id='synthetic-paid-prescription',requestId='synthetic-outpatient-medication-request'
  s.runtime.fhir.create(context,{resourceType:'MedicationRequest',id:requestId,status:'active',intent:'order',medication:{reference:{reference:'Medication/medication-amlodipine'}},subject:{reference:`Patient/${s.patient.id}`},encounter:{reference:`Encounter/${encounterId}`},requester:{reference:'PractitionerRole/practitioner-role-outpatient-doctor'}})
  db.prepare("INSERT INTO prescription(workspace_id,epoch,prescription_id,case_id,prescription_number,status,version,authored_by,authored_at,signed_at) VALUES(?,?,?,?,?,'paid',1,?,?,?)").run(context.workspaceId,context.epoch,id,caseId,'CM-SYNTHETIC-PAID','actor-doctor','2026-08-24T01:00:00.000Z','2026-08-24T01:00:00.000Z')
  db.prepare("UPDATE outpatient_case SET status='awaiting-dispense',prescription_id=? WHERE workspace_id=? AND epoch=? AND case_id=?").run(id,context.workspaceId,context.epoch,caseId)
  const row=z.object({code:z.string(),name_zh:z.string(),version:z.number()}).parse(db.prepare('SELECT * FROM outpatient_catalog WHERE workspace_id=? AND epoch=? AND item_id=?').get(context.workspaceId,context.epoch,'medication-amlodipine'))
  db.prepare('INSERT INTO prescription_item(workspace_id,epoch,prescription_id,medication_request_id,medication_id,medication_snapshot_json,quantity,dose_text,frequency_code,course_days) VALUES(?,?,?,?,?,?,30,?,?,30)').run(context.workspaceId,context.epoch,id,requestId,'medication-amlodipine',JSON.stringify({id:'medication-amlodipine',code:row.code,display:row.name_zh,version:String(row.version),system:'urn:clinmesh:operational:medication',sourceLocator:'operational:outpatient_catalog'}),'5 mg','QD')
  return {id,context}
}

describe('住院医嘱 HTTP 与真实 SQLite 合同', () => {
  it('逐项停嘱的共同与覆盖理由可由护士正式回读，原键重放不改变理由', async () => {
    const s = await setup()
    let clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
    for (const quantity of [1, 2]) {
      const response = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: clinical.encounterVersion,
        duration: 'temporary', selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity } })
      expect(response.status).toBe(200)
      clinical = inpatientFullClinicalResponseSchema.parse(await response.json()).data
    }
    const reasons = ['治疗计划调整', '该项教育已由另一安排覆盖']
    const attempts = clinical.orders.map((order, index) => ({ key: randomUUID(), input: {
      orderId: order.id, expectedOrderVersion: order.version, reason: reasons[index]!,
    } }))
    for (const attempt of attempts) {
      const response = await s.request(s.doctor, `${s.path}/orders/request-stop`, attempt.input, attempt.key)
      expect(response.status).toBe(200)
      const receipt = inpatientFullClinicalResponseSchema.parse(await response.json())
      expect(receipt.data.orders.find(order => order.id === attempt.input.orderId)).toMatchObject({
        state: 'stop-requested', version: 2, stopReason: attempt.input.reason,
      })
      const replay = await s.request(s.doctor, `${s.path}/orders/request-stop`, attempt.input, attempt.key)
      expect(inpatientFullClinicalResponseSchema.parse(await replay.json())).toEqual(receipt)
    }
    const nurseRead = inpatientFullClinicalSchema.parse(await (await s.request(s.nurse, `${s.path}/clinical`)).json())
    expect(nurseRead.orders).toEqual(expect.arrayContaining(attempts.map(attempt => expect.objectContaining({
      id: attempt.input.orderId, stopReason: attempt.input.reason, state: 'stop-requested',
    }))))
    expect(nurseRead.executions).toEqual([])
    expect(nurseRead.chargesFen).toBe(0)
    for (const order of nurseRead.orders) {
      const response = await s.request(s.nurse, `${s.path}/orders/verify-stop`, { orderId: order.id, expectedOrderVersion: order.version })
      expect(response.status).toBe(200)
      expect(inpatientFullClinicalResponseSchema.parse(await response.json()).data.orders.find(item => item.id === order.id))
        .toMatchObject({ state: 'stopped', version: 3, stopReason: reasons[attempts.findIndex(attempt => attempt.input.orderId === order.id)] })
    }
  })

  it('旧停嘱记录无明确理由来源时不猜测备注，也不阻止原护士核停', async () => {
    const s = await setup()
    const issued = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/orders/issue`, {
      encounterVersion: s.admission.versionId, duration: 'temporary',
      selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 },
    })).json()).data
    const order = issued.orders[0]!
    expect((await s.request(s.doctor, `${s.path}/orders/request-stop`, { orderId: order.id, expectedOrderVersion: order.version, reason: '原停嘱记录' })).status).toBe(200)
    // 构造旧版只保留普通 Annotation 的历史输入；后续行为仍经公开 HTTP 验收。
    const context = sessionContextSchema.parse(await (await s.request(s.nurse, '/api/auth/context')).json()).actor
    const request = s.runtime.fhir.read(context, 'ServiceRequest', order.id)
    s.runtime.fhir.update(context, { ...request, note: [{ text: '历史普通备注' }, { id: 'another-note', text: '不能推断为停嘱理由' }] }, request.meta!.versionId!)
    const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.nurse, `${s.path}/clinical`)).json())
    expect(clinical.orders[0]).not.toHaveProperty('stopReason')
    const stopped = await s.request(s.nurse, `${s.path}/orders/verify-stop`, { orderId: order.id, expectedOrderVersion: 2 })
    expect(stopped.status).toBe(200)
    expect(inpatientFullClinicalResponseSchema.parse(await stopped.json()).data.orders[0]).toMatchObject({ state: 'stopped', version: 3 })
  })

  it('连续停嘱后项冲突不回滚成功，核停取消待执行但保留已发已给及库存费用', async () => {
    const s = await setup()
    let clinical = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
      encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia', role: 'primary', admissionCondition: '1' }],
    })).json()).data
    for (const selection of [
      { kind: 'medication', catalogItemId: 'medication-metformin', catalogVersion: 1, frequencyCode: 'BID', doseText: '0.5 g', doseQuantity: 1 },
      { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 },
    ]) {
      const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: clinical.encounterVersion, duration: 'long',
        selection })
      expect(issued.status, await issued.clone().text()).toBe(200)
      clinical = inpatientFullClinicalResponseSchema.parse(await issued.json()).data
    }
    for (const order of clinical.orders) {
      const verified = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })
      expect(verified.status).toBe(200)
    }
    const clock = await (await s.request(s.admin, '/api/sim/v1/scenario-runs/current')).json()
    expect((await s.request(s.admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: clock.virtualTime, targetVirtualTime: '2026-08-25T01:00:00.000Z',
    })).status).toBe(200)
    clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.nurse, `${s.path}/clinical`)).json())
    const first = clinical.orders[0]!, second = clinical.orders[1]!
    const firstTasks = clinical.executions.filter(execution => execution.orderId === first.id)
    expect(firstTasks).toHaveLength(3)
    for (const execution of firstTasks.slice(0, 2)) {
      const catalog = inpatientFullCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json())
      const lot = catalog.medications.find(item => item.id === 'medication-metformin')!.lots[0]!
      expect((await s.request(s.pharmacist, `${s.path}/executions/dispense`, { executionId: execution.id, expectedExecutionVersion: execution.version,
        lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: first.doseQuantity }],
      })).status).toBe(200)
    }
    expect((await s.request(s.nurse, `${s.path}/executions/administer`, { executionId: firstTasks[0]!.id, expectedExecutionVersion: 2 })).status).toBe(200)
    const baseline = inpatientFullClinicalSchema.parse(await (await s.request(s.nurse, `${s.path}/clinical`)).json())
    const baselineCatalog = inpatientFullCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json())
    const baselineAdministrations = fhirBundleSchema.parse(await (await s.request(s.doctor, `/fhir/R5/MedicationAdministration?encounter=Encounter/${s.admission.id}&_total=accurate`)).json())
    expect(baselineAdministrations.total).toBe(1)
    const key = randomUUID(), input = { orderId: first.id, expectedOrderVersion: first.version, reason: '调整治疗计划' }
    const saved = await s.request(s.doctor, `${s.path}/orders/request-stop`, input, key)
    expect(saved.status).toBe(200)
    const receipt = inpatientFullClinicalResponseSchema.parse(await saved.json())
    expect((await s.request(s.doctor, `${s.path}/orders/request-stop`, { orderId: second.id, expectedOrderVersion: 1, reason: '个别调整' })).status).toBe(409)
    const partial = inpatientFullClinicalSchema.parse(await (await s.request(s.nurse, `${s.path}/clinical`)).json())
    expect(partial.orders.find(order => order.id === first.id)).toMatchObject({ state: 'stop-requested', stopReason: input.reason, version: 3 })
    expect(partial.orders.find(order => order.id === second.id)).toMatchObject({ state: 'verified', version: 2 })
    expect((await s.request(s.nurse, `${s.path}/executions/administer`, { executionId: firstTasks[1]!.id, expectedExecutionVersion: 2 })).status).toBe(409)
    const lot = baselineCatalog.medications.find(item => item.id === 'medication-metformin')!.lots[0]!
    expect((await s.request(s.pharmacist, `${s.path}/executions/dispense`, { executionId: firstTasks[2]!.id, expectedExecutionVersion: 1,
      lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: first.doseQuantity }],
    })).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/orders/request-stop`, { orderId: second.id, expectedOrderVersion: second.version, reason: '个别调整' })).status).toBe(200)
    const stoppedRequests = inpatientFullClinicalSchema.parse(await (await s.request(s.nurse, `${s.path}/clinical`)).json())
    for (const order of stoppedRequests.orders) {
      const stopKey = randomUUID(), stopInput = { orderId: order.id, expectedOrderVersion: order.version }
      const stopped = await s.request(s.nurse, `${s.path}/orders/verify-stop`, stopInput, stopKey)
      expect(stopped.status).toBe(200)
      const stopReceipt = inpatientFullClinicalResponseSchema.parse(await stopped.json())
      expect(inpatientFullClinicalResponseSchema.parse(await (await s.request(s.nurse, `${s.path}/orders/verify-stop`, stopInput, stopKey)).json())).toEqual(stopReceipt)
    }
    expect(inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/orders/request-stop`, input, key)).json())).toEqual(receipt)
    const final = inpatientFullClinicalSchema.parse(await (await s.request(s.nurse, `${s.path}/clinical`)).json())
    expect(final.orders.every(order => order.state === 'stopped')).toBe(true)
    expect(final.executions.find(execution => execution.id === firstTasks[0]!.id)).toEqual(baseline.executions.find(execution => execution.id === firstTasks[0]!.id))
    expect(final.executions.filter(execution => execution.status === 'cancelled')).toHaveLength(3)
    expect(final.dispenses).toEqual(baseline.dispenses)
    expect(final.charges).toEqual(baseline.charges)
    expect(final.chargesFen).toBe(baseline.chargesFen)
    expect(inpatientFullCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json()).medications).toEqual(baselineCatalog.medications)
    expect(fhirBundleSchema.parse(await (await s.request(s.doctor, `/fhir/R5/MedicationAdministration?encounter=Encounter/${s.admission.id}&_total=accurate`)).json()).entry).toEqual(baselineAdministrations.entry)
    expect((await s.request(s.admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: '2026-08-25T01:00:00.000Z', targetVirtualTime: '2026-08-26T01:00:00.000Z',
    })).status).toBe(200)
    expect(inpatientFullClinicalSchema.parse(await (await s.request(s.nurse, `${s.path}/clinical`)).json()).executions).toEqual(final.executions)
  })

  it('共享目录成功与越岗读取均有审计，自由搜索正文不进入审计资源', async () => {
    const s = await setup()
    const query = 'SYNTHETIC-SEARCH-NOT-FOR-AUDIT'
    const endpoint = `/api/his/v1/inpatient/catalog-search?kind=medication&source=hospital&query=${query}`
    expect((await s.request(s.doctor, endpoint)).status).toBe(200)
    expect((await s.request(s.nurse, endpoint)).status).toBe(403)
    const audits = fhirBundleSchema.parse(await (await s.request(s.admin, '/fhir/R5/AuditEvent?_count=100')).json())
    const events = (audits.entry ?? []).flatMap(entry => entry.resource ? [entry.resource] : []).filter(resource => {
      const code = z.object({ text: z.string() }).safeParse(resource.code)
      return code.success && code.data.text === 'inpatient.catalog.search'
    })
    expect(events).toHaveLength(2)
    expect(events.map(event => z.object({ code: z.object({ code: z.string() }) }).parse(event.outcome).code.code).sort()).toEqual(['0', '8'])
    expect(events.every(event => event.action === 'R')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(query)
  })

  it('共享参考检验精确关联已发布院内根项目，组合子项不能独立开立', async () => {
    const concepts: ReferenceConcept[] = [
      { id: 'laboratory:synthetic-orderable', domain: 'laboratory', code: '6690-2', display: '合成参考根检验', system: 'http://loinc.org', version: '2.83', sourceLocator: 'synthetic:orderable', status: 'active' },
      { id: 'laboratory:synthetic-component', domain: 'laboratory', code: '789-8', display: '合成参考子检验', system: 'http://loinc.org', version: '2.83', sourceLocator: 'synthetic:component', status: 'active' },
    ]
    const s = await setup(true, concepts)
    for (const [index, concept] of concepts.entries()) {
      const { domain: _domain, status: _status, ...snapshot } = concept
      const service = laboratoryServiceSnapshotSchema.parse({ id: `synthetic-lab-${index}`, version: 1, serviceKind: 'laboratory', doctorOrderable: index === 0,
        localCode: `SYN-LAB-${index}`, nameZh: concept.display, referenceConcept: snapshot, referenceReleaseId: 'synthetic-clinical-2022', componentServiceIds: [],
        executingDepartmentId: 'department-laboratory', allowedIndicationCodes: ['clinical-assessment'], specimen: { code: '119297000', display: '血液标本' }, tatMinutes: 20, priceFen: 800,
        reportDefinition: { conclusionTemplate: '合成检验结果。', results: [{ referenceConcept: snapshot, valueType: 'quantity', referenceRange: { low: 4, high: 10, text: '合成范围' }, unit: { system: 'http://unitsofmeasure.org', code: '10*9/L', display: '10^9/L' } }] } })
      s.runtime.database.driver.prepare('INSERT INTO hospital_service_catalog(workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json) VALUES(?,?,?,?,?,?,1,1,?)')
        .run('workspace-demo', 'epoch-1', service.id, service.localCode, service.nameZh, service.nameZh, JSON.stringify({ laboratoryService: service,
          availableScopes: ['inpatient'], billingUnit: { display: '项目' }, chargeDefinition: { id: `synthetic-charge-${index}`, currency: 'CNY', priceFen: 800 } }))
    }
    const response = await s.request(s.doctor, `/api/his/v1/inpatient/catalog-search?kind=laboratory&source=reference&query=${encodeURIComponent('合成参考')}`)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ releaseId: 'synthetic-clinical-2022', total: 2 })
    expect(result.items).toContainEqual(expect.objectContaining({ referenceId: concepts[0]!.id, status: 'available', catalogItemId: 'synthetic-lab-0', laboratory: { indicationCodes: ['clinical-assessment'], priceFen: 800 } }))
    const component = result.items.find((item: { referenceId: string }) => item.referenceId === concepts[1]!.id)
    expect(component).toMatchObject({ status: 'incomplete', missingFields: ['not-orderable'] })
    expect(component).not.toHaveProperty('catalogItemId')
  })

  it('参考候选只精确映射同产品版本，歧义和停用不提供可写身份', async () => {
    const s = await setup()
    const endpoint = `/api/his/v1/inpatient/catalog-search?kind=medication&source=reference&query=${encodeURIComponent('氨氯')}`
    const initial = await (await s.request(s.doctor, endpoint)).json()
    expect(initial.items).toEqual([expect.objectContaining({ status: 'available', catalogItemId: 'medication-amlodipine', catalogVersion: 1 })])
    s.runtime.database.driver.prepare("UPDATE outpatient_catalog SET config_json=json_set(config_json,'$.product.version','different-product-version') WHERE item_id='medication-amlodipine'").run()
    const unmapped = (await (await s.request(s.doctor, endpoint)).json()).items[0]
    expect(unmapped.status).toBe('incomplete')
    expect(unmapped.missingFields).toContain('hospital-mapping')
    expect(unmapped).not.toHaveProperty('catalogItemId')
    s.runtime.database.driver.prepare("UPDATE outpatient_catalog SET config_json=json_set(config_json,'$.product.version','nhsa-medication-products-2026-08-07') WHERE item_id='medication-amlodipine'").run()
    s.runtime.database.driver.prepare(`INSERT INTO outpatient_catalog(workspace_id,epoch,item_id,kind,code,name_zh,name_en,price_fen,version,active,config_json)
      SELECT workspace_id,epoch,'medication-amlodipine-duplicate',kind,'DUPLICATE-AMLODIPINE',name_zh,name_en,price_fen,version,active,config_json FROM outpatient_catalog WHERE item_id='medication-amlodipine'`).run()
    const ambiguous = (await (await s.request(s.doctor, endpoint)).json()).items[0]
    expect(ambiguous).toMatchObject({ status: 'incomplete', missingFields: ['ambiguous-mapping'] })
    expect(ambiguous).not.toHaveProperty('catalogItemId')
    s.runtime.database.driver.prepare("DELETE FROM outpatient_catalog WHERE item_id='medication-amlodipine-duplicate'").run()
    s.runtime.database.driver.prepare("UPDATE outpatient_catalog SET active=0 WHERE item_id='medication-amlodipine'").run()
    const inactive = (await (await s.request(s.doctor, endpoint)).json()).items[0]
    expect(inactive.status).toBe('inactive')
    expect(inactive).not.toHaveProperty('catalogItemId')
  })

  it('分页搜索保留未配齐药品并显示具体缺项，完整项目仍可使用', async () => {
    const s = await setup()
    const endpoint = '/api/his/v1/inpatient/catalog-search?kind=medication&source=hospital'
    const before = await (await s.request(s.doctor, endpoint)).json()
    const beforeReady = inpatientFullCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json())
    s.runtime.database.driver.prepare("UPDATE outpatient_catalog SET config_json=json_remove(config_json,'$.unit') WHERE item_id='medication-amlodipine'").run()
    const response = await s.request(s.doctor, `${endpoint}&query=${encodeURIComponent('氨氯')}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ kind: 'medication', source: 'hospital', total: 1,
      items: [{ id: 'medication-amlodipine', status: 'incomplete', missingFields: ['unit'] }] })
    const page = await (await s.request(s.doctor, `${endpoint}&pageSize=1&page=2`)).json()
    expect(page).toMatchObject({ page: 2, pageSize: 1, total: before.total })
    expect(page.items).toHaveLength(1)
    const ready = inpatientFullCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json())
    expect(ready.medications.map(item => item.id)).not.toContain('medication-amlodipine')
    expect(ready.medications).toHaveLength(beforeReady.medications.length - 1)
    for (const cookie of [s.nurse, s.cashier, s.pharmacist, s.admin]) expect((await s.request(cookie, endpoint)).status).toBe(403)
    expect((await s.request(s.doctor, `${endpoint}&pageSize=51`)).status).toBe(400)
  })

  it('医生填写目录建议外的合法剂量并按明确含量换算，拒绝不整片、超量和伪造数量', async () => {
    const s = await setup()
    s.runtime.database.driver.prepare(`UPDATE outpatient_catalog SET config_json=json_set(config_json,
      '$.inpatientDoseBasis',json('{"amount":5,"unit":"mg"}'),'$.inpatientMaxDoseQuantity',2) WHERE item_id='medication-amlodipine'` ).run()
    const diagnosis = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
      encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }],
    })).json()).data
    const selection = { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '10 mg', doseQuantity: 2, frequencyCode: 'QD' }
    const input = { encounterVersion: diagnosis.encounterVersion, duration: 'temporary', selection }
    for (const invalid of [{ ...selection, doseText: '7.5 mg' }, { ...selection, doseText: '15 mg', doseQuantity: 3 },
      { ...selection, doseQuantity: 1 }, { ...selection, doseText: '10 mL' }]) {
      expect((await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, selection: invalid })).status).toBe(409)
    }
    const result = await s.request(s.doctor, `${s.path}/orders/issue`, input)
    expect(result.status).toBe(200)
    const clinical = inpatientFullClinicalResponseSchema.parse(await result.json()).data
    expect(clinical.orders).toEqual([expect.objectContaining({ doseText: '10 mg', doseQuantity: 2, unit: '片' })])
    const order = clinical.orders[0]!
    const verified = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).json()).data
    const execution = verified.executions[0]!
    const pharmacy = inpatientPharmacySchema.parse(await (await s.request(s.pharmacist, `${s.path}/pharmacy`)).json())
    const lot = pharmacy.medications[0]!.lots[0]!
    const dispense = { executionId: execution.id, expectedExecutionVersion: execution.version, lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: 2 }] }
    const key = randomUUID(), supplied = await s.request(s.pharmacist, `${s.path}/executions/dispense`, dispense, key)
    expect(supplied.status).toBe(200)
    const receipt = inpatientPharmacyResponseSchema.parse(await supplied.json())
    expect(receipt.data.dispenses).toEqual([expect.objectContaining({ quantity: 2 })])
    expect(await (await s.request(s.pharmacist, `${s.path}/executions/dispense`, dispense, key)).json()).toEqual(receipt)
    const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    expect(charges.charges).toEqual([expect.objectContaining({ amountFen: 3000, label: '苯磺酸氨氯地平片 2片' })])
    const inventory = fhirResourceSchema.parse(await (await s.request(s.pharmacist, `/fhir/R5/InventoryItem/${lot.id}`)).json())
    expect(inventory.netContent).toMatchObject({ value: 998 })
    expect(inventory.meta?.versionId).toBe(String(lot.version + 1))
    expect(receipt.effects).toContainEqual({ kind: 'updated', reference: `InventoryItem/${lot.id}`, versionId: String(lot.version + 1) })
  })

  it('无质量换算基底也可按明确制剂单位开立，建议枚举为空不隐藏合法项目', async () => {
    const s = await setup()
    s.runtime.database.driver.prepare(`UPDATE outpatient_catalog SET config_json=json_set(json_remove(config_json,'$.inpatientDoses','$.inpatientDoseBasis'),
      '$.inpatientMaxDoseQuantity',2) WHERE item_id='medication-amlodipine'`).run()
    const catalog = await (await s.request(s.doctor, `/api/his/v1/inpatient/catalog-search?kind=medication&source=hospital&query=${encodeURIComponent('氨氯')}`)).json()
    expect(catalog.items).toEqual([expect.objectContaining({ status: 'available', catalogItemId: 'medication-amlodipine', medication: expect.objectContaining({ doses: [], maxDoseQuantity: 2 }) })])
    const diagnosis = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
      encounterVersion: s.admission.versionId, expectedRevision: 0, entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }],
    })).json()).data
    const input = { encounterVersion: diagnosis.encounterVersion, duration: 'temporary', selection: { kind: 'medication',
      catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '10 mg', doseQuantity: 2, frequencyCode: 'QD' } }
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, input)).status).toBe(409)
    const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, selection: { ...input.selection, doseText: '2片' } })
    expect(issued.status).toBe(200)
    expect(inpatientFullClinicalResponseSchema.parse(await issued.json()).data.orders).toEqual([expect.objectContaining({ doseText: '2片', doseQuantity: 2 })])
  })

  it('混合时区Virtual Time的临床医嘱执行发药账目及药房清单按真实时点排序', async () => {
    const s = await setup()
    const clock = await (await s.request(s.admin, '/api/sim/v1/scenario-runs/current')).json()
    const diagnosis = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }] })).json()).data
    const dose = async () => {
      const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: diagnosis.encounterVersion, duration: 'temporary', selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })
      expect(issued.status).toBe(200)
      const order = inpatientFullClinicalResponseSchema.parse(await issued.json()).data.orders.find(item => item.state === 'signed')!
      const verified = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })
      expect(verified.status).toBe(200)
      const execution = inpatientFullClinicalResponseSchema.parse(await verified.json()).data.executions.find(item => item.orderId === order.id)!
      const pharmacy = inpatientPharmacySchema.parse(await (await s.request(s.pharmacist, `${s.path}/pharmacy`)).json())
      const lot = pharmacy.medications.find(item => item.id === 'medication-amlodipine')!.lots[0]!
      const supplied = await s.request(s.pharmacist, `${s.path}/executions/dispense`, { executionId: execution.id, expectedExecutionVersion: execution.version, lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: 1 }] })
      expect(supplied.status).toBe(200)
      const dispensed = inpatientPharmacyResponseSchema.parse(await supplied.json()).data
      const dispense = dispensed.dispenses.find(item => item.executionId === execution.id)!
      const administered = await s.request(s.nurse, `${s.path}/executions/administer`, { executionId: execution.id, expectedExecutionVersion: dispensed.executions.find(item => item.id === execution.id)!.version })
      expect(administered.status).toBe(200)
      const charge = inpatientFullClinicalResponseSchema.parse(await administered.json()).data.charges.find(item => item.sourceId === dispense.id)!
      return { order, execution, dispense, charge }
    }
    const first = await dose(), laterTime = new Date(Date.parse(clock.virtualTime) + 1).toISOString()
    expect((await s.request(s.admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: clock.virtualTime, targetVirtualTime: laterTime })).status).toBe(200)
    const later = await dose()
    const registered = inpatientCommandResponseSchema.parse(await (await s.request(s.registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: s.patient.id, patientVersion: s.patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 })).json()).data.admission
    const received = inpatientCommandResponseSchema.parse(await (await s.request(s.nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, { encounterVersion: registered.versionId, bedId: 'bed-general-2' })).json()).data.admission
    const secondDiagnosis = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `/api/his/v1/inpatient/admissions/${received.id}/diagnoses/confirm`, { encounterVersion: received.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }] })).json()).data
    expect((await s.request(s.doctor, `/api/his/v1/inpatient/admissions/${received.id}/orders/issue`, { encounterVersion: secondDiagnosis.encounterVersion, duration: 'temporary', selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })).status).toBe(200)
    const before = canonicalStateHash(s.runtime.database)
    const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
    const pharmacy = inpatientPharmacySchema.parse(await (await s.request(s.pharmacist, `${s.path}/pharmacy`)).json())
    const ledger = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    const queue = inpatientPharmacyListSchema.parse(await (await s.request(s.pharmacist, '/api/his/v1/inpatient/pharmacy/admissions')).json())
    for (const facts of [clinical, pharmacy]) {
      expect.soft(facts.orders.map(item => item.id)).toEqual([first.order.id, later.order.id])
      expect.soft(facts.executions.map(item => item.id)).toEqual([first.execution.id, later.execution.id])
      expect.soft(facts.dispenses.map(item => item.id)).toEqual([first.dispense.id, later.dispense.id])
    }
    expect.soft(clinical.charges.map(item => item.id)).toEqual([first.charge.id, later.charge.id])
    expect.soft(ledger.charges.map(item => item.id)).toEqual([first.charge.id, later.charge.id])
    expect.soft(queue.items.map(item => item.admissionId)).toEqual([s.admission.id, received.id])
    expect(clinical.executions.find(item => item.id === first.execution.id)?.scheduledFor).toBe(clock.virtualTime)
    expect(clinical.executions.find(item => item.id === later.execution.id)?.scheduledFor).toBe(laterTime)
    expect(clinical.dispenses.find(item => item.id === later.dispense.id)?.dispensedAt).toBe(laterTime)
    expect(ledger.charges.find(item => item.id === later.charge.id)?.virtualTime).toBe(laterTime)
    expect(canonicalStateHash(s.runtime.database)).toBe(before)
  })

  it('药房与收费使用独立窄响应，旧住院通用及临床入口拒绝越权读取', async () => {
    const s = await setup()
    for (const role of [s.pharmacist, s.cashier]) expect((await s.request(role, `${s.path}/clinical`)).status).toBe(403)
    for (const path of ['/api/his/v1/inpatient/admissions', s.path, '/api/his/v1/inpatient/catalog', '/api/his/v1/inpatient/clinical-catalog']) {
      expect((await s.request(s.pharmacist, path)).status).toBe(403)
    }
    expect((await s.request(s.cashier, `${s.path}/pharmacy`)).status).toBe(403)
    expect((await s.request(s.pharmacist, `${s.path}/charges`)).status).toBe(403)
    const diagnosis = await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '2', note: '不属于收费或药房响应的合成诊断备注' }] })).json()
    const input = { encounterVersion: diagnosis.data.encounterVersion, duration: 'temporary' }
    await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } })
    await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })
    const pharmacy = await s.request(s.pharmacist, `${s.path}/pharmacy`)
    expect(pharmacy.status).toBe(200)
    const body = await pharmacy.json()
    expect(body.orders).toHaveLength(1)
    expect(body.orders[0].kind).toBe('medication')
    expect(body.admission).toMatchObject({ admissionId: s.admission.id, patientName: '合成医嘱患者' })
    for (const key of ['diagnosis', 'charges', 'chargesFen', 'financialStatus', 'services']) expect(body).not.toHaveProperty(key)
    for (const key of ['depositFen', 'chargesFen', 'financialStatus', 'recordStatus']) expect(body.admission).not.toHaveProperty(key)
    expect(JSON.stringify(body)).not.toContain('不属于收费或药房响应')
    expect(body).toHaveProperty('medicationAllergies')
    const queue = await s.request(s.pharmacist, '/api/his/v1/inpatient/pharmacy/admissions')
    expect(queue.status).toBe(200)
    expect((await queue.json()).items).toEqual([body.admission])
    const charges = await s.request(s.cashier, `${s.path}/charges`)
    expect(charges.status).toBe(200)
    const ledger = await charges.json()
    for (const key of ['diagnosis', 'orders', 'executions', 'dispenses', 'encounterVersion']) expect(ledger).not.toHaveProperty(key)
    expect(ledger).toMatchObject({ admissionId: s.admission.id, financialStatus: 'open', charges: [], chargesFen: 0 })
  })

  it('住院医生确认真实目录诊断形成本次Condition及Encounter诊断，拒绝非医生和无效目录', async () => {
    const s = await setup()
    const input = { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-type-2-diabetes', role: 'primary', admissionCondition: '1' }] }
    const catalog = await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')
    expect(catalog.status).toBe(200)
    const diagnoses = (await catalog.json()).diagnoses
    const diabetes = diagnoses.find((d: { code: string }) => d.code === 'E11.65')
    expect(diabetes).toBeDefined()
    input.entries[0]!.catalogItemId = diabetes.id
    expect((await s.request(s.nurse, `${s.path}/diagnoses/confirm`, input)).status).toBe(403)
    expect((await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { ...input, entries: [{ catalogItemId: 'missing', role: 'primary', admissionCondition: '1' }] })).status).toBe(409)
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
      entries: [{ catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia', role: 'primary', admissionCondition: '1' }] })
    expect(diagnosis.status).toBe(200)
    issue.encounterVersion = (await diagnosis.json()).data.encounterVersion
    for (const selection of [{ ...issue.selection, catalogItemId: 'missing' }, { ...issue.selection, doseText: '500 g' },
      { ...issue.selection, frequencyCode: 'Q4H' }, { ...issue.selection, doseQuantity: 60 }, { ...issue.selection, catalogVersion: 999 },
      { ...issue.selection, catalogItemId: 'medication-amlodipine', doseText: '5 mg', frequencyCode: 'QD' }]) {
      const invalid = await s.request(s.doctor, `${s.path}/orders/issue`, { ...issue, selection })
      expect(invalid.status).toBe(selection.frequencyCode === 'Q4H' ? 400 : 409)
      expect((await invalid.json()).error.code).toBe(selection.frequencyCode === 'Q4H' ? 'INVALID_INPUT' : 'CATALOG_CONFLICT')
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

  it('连续校对的原回执在重启后仍逐项恢复，不重复计划或产生实际执行费用', async () => {
    const s = await setup()
    const diagnosis = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
      encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-fever', role: 'primary', admissionCondition: '1' }],
    })).json()).data
    let clinical = diagnosis
    for (const item of [
      { duration: 'temporary', selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } },
      { duration: 'long', selection: { kind: 'medication', catalogItemId: 'medication-acetaminophen', catalogVersion: 1, doseText: '0.5 g', doseQuantity: 1, frequencyCode: 'PRN' } },
    ]) {
      const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: clinical.encounterVersion, ...item })
      expect(issued.status, await issued.clone().text()).toBe(200)
      clinical = inpatientFullClinicalResponseSchema.parse(await issued.json()).data
    }
    expect(clinical.executions).toEqual([])
    const attempts = clinical.orders.map(order => ({ key: randomUUID(), input: { orderId: order.id, expectedOrderVersion: order.version } }))
    const receipts: unknown[] = []
    for (const attempt of attempts) {
      const verified = await s.request(s.nurse, `${s.path}/orders/verify`, attempt.input, attempt.key)
      expect(verified.status).toBe(200)
      receipts.push(inpatientFullClinicalResponseSchema.parse(await verified.json()))
    }
    await s.runtime.close()
    const restarted = await createClinMeshRuntime({ authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: s.databasePath, demoPassword: s.password, migrationMode: 'apply', trustedOrigins: ['http://localhost'] })
    try {
      for (const [index, attempt] of attempts.entries()) {
        const recovered = await restarted.app.request(`/api/his/v1/command-receipts?operationId=inpatient.order.verify&idempotencyKey=${attempt.key}`, { headers: { cookie: s.nurse } })
        expect(recovered.status).toBe(200)
        expect(inpatientFullClinicalResponseSchema.parse((await recovered.json()).response)).toEqual(receipts[index])
        const replay = await restarted.app.request(`${s.path}/orders/verify`, { method: 'POST', headers: {
          cookie: s.nurse, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': attempt.key,
        }, body: JSON.stringify({ input: attempt.input }) })
        expect(replay.status).toBe(200)
        expect(inpatientFullClinicalResponseSchema.parse(await replay.json())).toEqual(receipts[index])
      }
      const final = inpatientFullClinicalSchema.parse(await (await restarted.app.request(`${s.path}/clinical`, { headers: { cookie: s.nurse } })).json())
      expect(final.orders).toHaveLength(2)
      expect(final.orders.every(order => order.state === 'verified' && order.version === 2)).toBe(true)
      expect(final.executions).toHaveLength(1)
      expect(final.executions.every(execution => execution.status === 'pending')).toBe(true)
      expect(final.executions.some(execution => final.orders.find(order => order.id === execution.orderId)?.frequencyCode === 'PRN')).toBe(false)
      expect(final.dispenses).toEqual([])
      expect(final.charges).toEqual([])
      for (const resourceType of ['MedicationAdministration', 'MedicationDispense']) {
        const resources = fhirBundleSchema.parse(await (await restarted.app.request(`/fhir/R5/${resourceType}?_total=accurate`, { headers: { cookie: s.doctor } })).json())
        expect(resources.total).toBe(0)
      }
      const audits = fhirBundleSchema.parse(await (await restarted.app.request('/fhir/R5/AuditEvent?_count=100', { headers: { cookie: s.admin } })).json())
      const verifications = (audits.entry ?? []).flatMap(entry => entry.resource ? [entry.resource] : []).filter(resource =>
        z.object({ text: z.string() }).safeParse(resource.code).data?.text === 'inpatient.order.verify'
        && z.object({ code: z.object({ code: z.string() }) }).parse(resource.outcome).code.code === '0')
      expect(verifications).toHaveLength(2)
    } finally { await restarted.close() }
  })

  it('连续校对中后项状态冲突保留首项结果，核停医嘱不能混入新医嘱校对', async () => {
    const s = await setup()
    let clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.nurse, `${s.path}/clinical`)).json())
    for (let index = 0; index < 3; index += 1) {
      const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: clinical.encounterVersion, duration: 'temporary',
        selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } })
      expect(issued.status).toBe(200)
      clinical = inpatientFullClinicalResponseSchema.parse(await issued.json()).data
    }
    const [first, changed, last] = clinical.orders
    expect(first && changed && last).toBeTruthy()
    const key = randomUUID()
    const firstInput = { orderId: first!.id, expectedOrderVersion: first!.version }
    const completed = await s.request(s.nurse, `${s.path}/orders/verify`, firstInput, key)
    expect(completed.status).toBe(200)
    const firstReceipt = inpatientFullClinicalResponseSchema.parse(await completed.json())
    expect((await s.request(s.doctor, `${s.path}/orders/request-stop`, {
      orderId: changed!.id, expectedOrderVersion: changed!.version, reason: '合成核实：取消重复教育安排',
    })).status).toBe(200)
    const rejected = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: changed!.id, expectedOrderVersion: changed!.version })
    expect(rejected.status).toBe(409)
    expect((await rejected.json()).error.code).toBe('INPATIENT_ORDER_CONFLICT')
    expect((await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: last!.id, expectedOrderVersion: last!.version })).status).toBe(200)
    expect(inpatientFullClinicalResponseSchema.parse(await (await s.request(s.nurse, `${s.path}/orders/verify`, firstInput, key)).json())).toEqual(firstReceipt)
    const final = inpatientFullClinicalSchema.parse(await (await s.request(s.nurse, `${s.path}/clinical`)).json())
    expect(final.orders.filter(order => order.state === 'verified')).toHaveLength(2)
    expect(final.orders.find(order => order.id === changed!.id)?.state).toBe('stop-requested')
    expect(final.executions).toHaveLength(2)
    expect(final.executions.every(execution => execution.orderId !== changed!.id && execution.status === 'pending')).toBe(true)
    expect(final.dispenses).toEqual([])
    expect(final.charges).toEqual([])
  })

  it('长期BID同批次两执行单顺序发药按单推进库存版本，原回执与重启重放不重复扣库或计费', async () => {
    const { s, pharmacy, order, medication, lot, input, facts } = await pendingBidDispenses()
    const baseline = await facts()
    const attempts = [0, 1].map(index => ({ input: input(index, lot.version + index), key: randomUUID() }))
    const results: Array<z.infer<typeof inpatientPharmacyResponseSchema>> = []
    for (const [index, attempt] of attempts.entries()) {
      const response = await s.request(s.pharmacist, `${s.path}/executions/dispense`, attempt.input, attempt.key)
      expect(response.status, await response.clone().text()).toBe(200)
      const result = inpatientPharmacyResponseSchema.parse(await response.json())
      results.push(result)
      expect(result.effects.filter(effect => effect.reference.startsWith('InventoryItem/'))).toEqual([
        { kind: 'updated', reference: `InventoryItem/${lot.id}`, versionId: String(lot.version + index + 1) },
      ])
      expect(result.effects.filter(effect => effect.reference.startsWith('MedicationDispense/'))).toHaveLength(1)
      expect(result.data.executions.find(item => item.id === attempt.input.executionId)).toMatchObject({
        status: 'dispensed', version: attempt.input.expectedExecutionVersion + 1,
      })
      expect(result.data.medications.find(item => item.id === order.catalogItemId)!.lots.find(item => item.id === lot.id))
        .toMatchObject({ version: lot.version + index + 1, quantityOnHand: lot.quantityOnHand - index - 1 })
    }
    const final = await facts()
    expect(final.inventory).toMatchObject({ meta: { versionId: String(lot.version + 2) }, netContent: { value: lot.quantityOnHand - 2 } })
    expect(final.pharmacy.executions.map(item => item.status)).toEqual(['dispensed', 'dispensed', 'pending'])
    expect(final.pharmacy.dispenses).toHaveLength(2)
    expect(final.pharmacy.dispenses.map(item => item.executionId)).toEqual(pharmacy.executions.slice(0, 2).map(item => item.id))
    expect(final.charges.charges.filter(item => item.kind === 'medication')).toEqual(final.pharmacy.dispenses.map(item => expect.objectContaining({
      sourceId: item.id, amountFen: medication.priceFen, label: `${order.display} 1${order.unit}`,
    })))
    expect(final.charges.chargesFen - baseline.charges.chargesFen).toBe(medication.priceFen * 2)
    for (const restarted of [false, true]) {
      if (restarted) await s.restart()
      for (const [index, attempt] of attempts.entries()) {
        const receipt = commandReceiptLookupSchema.parse(await (await s.request(s.pharmacist,
          `/api/his/v1/command-receipts?operationId=inpatient.execution.dispense&idempotencyKey=${attempt.key}`)).json())
        expect(receipt).toMatchObject({ operationId: 'inpatient.execution.dispense', idempotencyKey: attempt.key, status: 'completed' })
        expect(inpatientPharmacyResponseSchema.parse(receipt.response)).toEqual(results[index])
        const replay = await s.request(s.pharmacist, `${s.path}/executions/dispense`, attempt.input, attempt.key)
        expect(replay.status).toBe(200)
        expect(inpatientPharmacyResponseSchema.parse(await replay.json())).toEqual(results[index])
      }
      expect(await facts()).toEqual(final)
      for (const dispense of final.pharmacy.dispenses) {
        const resource = await s.request(s.pharmacist, `/fhir/R5/MedicationDispense/${dispense.id}`)
        expect(resource.status).toBe(200)
        expect(fhirResourceSchema.parse(await resource.json())).toMatchObject({ id: dispense.id, status: 'completed', meta: { versionId: '1' },
          encounter: { reference: `Encounter/${s.admission.id}` }, authorizingPrescription: [{ reference: `MedicationRequest/${order.id}` }],
          medication: { reference: { reference: `Medication/${order.catalogItemId}` } }, quantity: { value: 1, unit: order.unit } })
      }
    }
  })

  it.each(['stock', 'stopped'] as const)('后项%s冲突与原键重试不改前项成功，外部同批次消耗不自动接受新版本', async conflict => {
    const { s, pharmacy, medication, lot, input, facts } = await pendingBidDispenses()
    const firstInput = input(0, lot.version), firstKey = randomUUID()
    const response = await s.request(s.pharmacist, `${s.path}/executions/dispense`, firstInput, firstKey)
    expect(response.status).toBe(200)
    const first = inpatientPharmacyResponseSchema.parse(await response.json())
    const nextInput = input(1, lot.version + 1), nextKey = randomUUID()
    if (conflict === 'stock') {
      // 独立发药争用同一库存；原批次只能认可自己首项贡献的一次版本推进。
      expect((await s.request(s.pharmacist, `${s.path}/executions/dispense`, input(2, lot.version + 1))).status).toBe(200)
    } else {
      const order = first.data.orders[0]!
      expect((await s.request(s.doctor, `${s.path}/orders/request-stop`, {
        orderId: order.id, expectedOrderVersion: order.version, reason: '合成方案调整，暂停后续发药',
      })).status).toBe(200)
    }
    const before = await facts()
    expect(before.inventory).toMatchObject({ meta: { versionId: String(lot.version + (conflict === 'stock' ? 2 : 1)) },
      netContent: { value: lot.quantityOnHand - (conflict === 'stock' ? 2 : 1) } })
    for (let retry = 0; retry < 2; retry += 1) {
      const rejected = await s.request(s.pharmacist, `${s.path}/executions/dispense`, nextInput, nextKey)
      expect(rejected.status).toBe(409)
      expect((await rejected.json()).error.code).toBe(conflict === 'stock' ? 'INPATIENT_STOCK_CONFLICT' : 'INPATIENT_EXECUTION_CONFLICT')
      expect(await facts()).toEqual(before)
    }
    expect(before.pharmacy.executions.find(item => item.id === pharmacy.executions[1]!.id)).toMatchObject({ status: 'pending', version: 1 })
    expect(before.pharmacy.dispenses).toEqual(expect.arrayContaining(first.data.dispenses))
    const originalCharge = before.charges.charges.find(item => item.sourceId === first.data.dispenses[0]!.id)
    expect(originalCharge).toMatchObject({ kind: 'medication', amountFen: medication.priceFen })
    const receipt = commandReceiptLookupSchema.parse(await (await s.request(s.pharmacist,
      `/api/his/v1/command-receipts?operationId=inpatient.execution.dispense&idempotencyKey=${firstKey}`)).json())
    expect(inpatientPharmacyResponseSchema.parse(receipt.response)).toEqual(first)
    expect(inpatientPharmacyResponseSchema.parse(await (await s.request(s.pharmacist, `${s.path}/executions/dispense`, firstInput, firstKey)).json())).toEqual(first)
    expect(await facts()).toEqual(before)
  })

  it('临时医嘱实际发药扣共享库存并产生逐项费用，未发药不能给药，重试不会重复消耗', async () => {
    const s = await setup()
    const diagnosis = await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }] })).json()
    const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: diagnosis.data.encounterVersion, duration: 'temporary',
      selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })
    expect(issued.status).toBe(200)
    const order = (await issued.json()).data.orders[0]
    const verified = await (await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).json()
    const execution = verified.data.executions[0]
    expect((await s.request(s.nurse, `${s.path}/executions/administer`, { executionId: execution.id, expectedExecutionVersion: execution.version })).status).toBe(409)
    const catalog = await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json()
    const medication = catalog.medications.find((m: { id: string }) => m.id === 'medication-amlodipine')
    const lot = medication.lots[0]
    const input = { executionId: execution.id, expectedExecutionVersion: execution.version, lotSelections: [{ lotId: lot.id, expectedVersion: 999, quantity: 1 }] }
    expect((await s.request(s.pharmacist, `${s.path}/executions/dispense`, input)).status).toBe(409)
    expect((await (await s.request(s.doctor, `${s.path}/clinical`)).json()).charges).toEqual([])
    input.lotSelections[0]!.expectedVersion = lot.version
    for(const [field,value,restored] of [['expires_on','2020-01-01',lot.expiresOn],['location_id','ward-general','location-pharmacist']] as const) {
      s.runtime.database.driver.prepare(`UPDATE inventory_lot SET ${field}=? WHERE workspace_id=? AND epoch=? AND lot_id=?`).run(value,'workspace-demo','epoch-1',lot.id)
      try { expect((await s.request(s.pharmacist,`${s.path}/executions/dispense`,input)).status).toBe(409) }
      finally { s.runtime.database.driver.prepare(`UPDATE inventory_lot SET ${field}=? WHERE workspace_id=? AND epoch=? AND lot_id=?`).run(restored,'workspace-demo','epoch-1',lot.id) }
    }
    const wrongLot=catalog.medications.find((item:{id:string})=>item.id==='medication-metformin').lots[0]
    expect((await s.request(s.pharmacist,`${s.path}/executions/dispense`,{...input,lotSelections:[{lotId:wrongLot.id,expectedVersion:wrongLot.version,quantity:1}]})).status).toBe(409)
    const key = randomUUID()
    const supplied = await s.request(s.pharmacist, `${s.path}/executions/dispense`, input, key)
    expect(supplied.status).toBe(200)
    const dispensed = await supplied.json()
    expect(await (await s.request(s.pharmacist, `${s.path}/executions/dispense`, input, key)).json()).toEqual(dispensed)
    expect(dispensed.data.dispenses).toHaveLength(1)
    expect(dispensed.data).not.toHaveProperty('charges')
    expect(dispensed.data).not.toHaveProperty('diagnosis')
    expect((await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges).toMatchObject([{ kind: 'medication', label: '苯磺酸氨氯地平片 1片', amountFen: medication.priceFen }])
    const receipt = await (await s.request(s.pharmacist, `/api/his/v1/command-receipts?operationId=inpatient.execution.dispense&idempotencyKey=${key}`)).json()
    expect(inpatientPharmacyResponseSchema.parse(receipt.response)).toEqual(dispensed)
    expect((await s.request(s.cashier, `/api/his/v1/command-receipts?operationId=inpatient.execution.dispense&idempotencyKey=${key}`)).status).toBe(404)
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
    const ledger = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    const charge = ledger.charges[0]
    const input = { chargeId: charge.id, expectedChargeVersion: charge.version, reason: '合成费用纠错' }
    expect((await s.request(s.nurse, `${s.path}/charges/reverse`, input)).status).toBe(403)
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, { ...input, expectedChargeVersion: 999 })).status).toBe(409)
    const key = randomUUID()
    const response = await s.request(s.cashier, `${s.path}/charges/reverse`, input, key)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.data).not.toHaveProperty('diagnosis')
    expect(result.data).not.toHaveProperty('orders')
    const receipt = await (await s.request(s.cashier, `/api/his/v1/command-receipts?operationId=inpatient.charge.reverse&idempotencyKey=${key}`)).json()
    expect(inpatientChargesResponseSchema.parse(receipt.response)).toEqual(result)
    expect((await s.request(s.pharmacist, `/api/his/v1/command-receipts?operationId=inpatient.charge.reverse&idempotencyKey=${key}`)).status).toBe(404)
    expect(result.data.chargesFen).toBe(0)
    expect(result.data.charges).toHaveLength(2)
    expect(result.data.charges.find((c: { id: string }) => c.id === charge.id)).toEqual(charge)
    expect(result.data.charges.find((c: { reversalOf?: string }) => c.reversalOf === charge.id)).toMatchObject({ amountFen: -5000, reason: '合成费用纠错' })
    expect(await (await s.request(s.cashier, `${s.path}/charges/reverse`, input, key)).json()).toEqual(result)
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, input)).status).toBe(409)
    const inverse = result.data.charges.find((c: { reversalOf?: string }) => c.reversalOf === charge.id)
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, { ...input, chargeId: inverse.id })).status).toBe(409)
    expect((await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(0)
  })

  it('PRN只由护士按已校对医嘱和理由显式创建，午夜不自动展开且停嘱立即拒绝新任务', async () => {
    const s = await setup()
    const diagnosed = await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-fever', role: 'primary', admissionCondition: '1' }] })).json()
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
    const unchanged=await s.request(s.admin,'/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time',{expectedVirtualTime:clock.virtualTime,targetVirtualTime:new Date(clock.virtualTime).toISOString()})
    expect(unchanged.status).toBe(200)
    expect((await s.request(s.nurse,`${s.path}/executions/request-prn`,input)).status).toBe(409)
    let virtualTime = clock.virtualTime
    for (const hour of [10, 11, 12, 13]) {
      const targetVirtualTime = `2026-08-24T${hour}:00:00+08:00`
      expect((await s.request(s.admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: virtualTime, targetVirtualTime })).status).toBe(200)
      virtualTime = scenarioStateSchema.parse(await (await s.request(s.admin, '/api/sim/v1/scenario-runs/current')).json()).virtualTime
      const response = await s.request(s.nurse, `${s.path}/executions/request-prn`, input)
      expect(response.status).toBe(hour === 13 ? 409 : 200)
      if (hour === 13) expect((await response.json()).error.reason).toBe('MEDICATION_DOSAGE_NOT_ALLOWED')
    }
    expect((await s.request(s.admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: virtualTime, targetVirtualTime: '2026-08-25T01:00:00.000Z' })).status).toBe(200)
    expect((await (await s.request(s.doctor, `${s.path}/clinical`)).json()).executions).toHaveLength(4)
    const stop = await s.request(s.doctor, `${s.path}/orders/request-stop`, { ...input, reason: '调整治疗' })
    expect(stop.status).toBe(200)
    input.expectedOrderVersion = (await stop.json()).data.orders[0].version
    expect((await s.request(s.nurse, `${s.path}/executions/request-prn`, input)).status).toBe(409)
  })

  it('临床详情严格排除登记员和管理员，读取岗位与Catalog一致', async () => {
    const s = await setup()
    expect((await s.request(s.registrar, `${s.path}/clinical`)).status).toBe(403)
    expect((await s.request(s.admin, `${s.path}/clinical`)).status).toBe(403)
    for (const cookie of [s.doctor,s.nurse]) expect((await s.request(cookie, `${s.path}/clinical`)).status).toBe(200)
  })

  it('住院医生可选择非legacy参考诊断，冻结真实版本来源与Release并按声明适应症开药', async () => {
    const s = await setup(true)
    const searched = await s.request(s.doctor, '/api/his/v1/reference-catalogs/diagnoses?query=高血压&page=1&pageSize=20')
    expect(searched.status).toBe(200)
    const search = await searched.json()
    expect(search.items[0].id).toBe('nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09')
    const confirmed = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion:s.admission.versionId,expectedRevision:0,
      entries:[{catalogItemId:search.items[0].id,role:'primary',admissionCondition:'1'}] })
    expect(confirmed.status).toBe(200)
    const data=(await confirmed.json()).data
    expect(data.diagnosis.entries[0].coding).toMatchObject({ id:'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09',version:'2022',sourceLocator:'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457',releaseId:'synthetic-clinical-2022' })
    const condition=fhirResourceSchema.parse(await(await s.request(s.doctor,`/fhir/R5/Condition/${data.diagnosis.entries[0].conditionId}`)).json())
    expect(condition).toMatchObject({code:{coding:[{code:'I10.x09',version:'2022'}]}})
    const input={encounterVersion:data.encounterVersion,duration:'temporary',selection:{kind:'medication',catalogItemId:'medication-amlodipine',catalogVersion:1,doseText:'5 mg',doseQuantity:1,frequencyCode:'QD'}}
    expect((await s.request(s.doctor,`${s.path}/orders/issue`,input)).status).toBe(200)
    expect((await s.request(s.doctor,`${s.path}/orders/issue`,{...input,selection:{...input.selection,catalogItemId:'medication-metformin',doseText:'0.5 g',frequencyCode:'BID'}})).status).toBe(409)
  })

  it('已确认药物过敏拒绝签发，跨病区及重置后的旧住院不能读取或写入', async () => {
    const s=await setup()
    const diagnosed=await(await s.request(s.doctor,`${s.path}/diagnoses/confirm`,{encounterVersion:s.admission.versionId,expectedRevision:0,entries:[{catalogItemId:'diagnosis-hypertension',role:'primary',admissionCondition:'1'}]})).json()
    const context=sessionContextSchema.parse(await(await s.request(s.admin,'/api/auth/context')).json()).actor
    s.runtime.fhir.create(context,{resourceType:'AllergyIntolerance',id:'synthetic-inpatient-allergy',patient:{reference:`Patient/${s.patient.id}`},category:['medication'],
      clinicalStatus:{coding:[{code:'active'}]},verificationStatus:{coding:[{code:'confirmed'}]},code:{coding:[{code:'AMLODIPINE'}]}})
    expect((await s.request(s.doctor,`${s.path}/orders/issue`,{encounterVersion:diagnosed.data.encounterVersion,duration:'temporary',selection:{kind:'medication',catalogItemId:'medication-amlodipine',catalogVersion:1,doseText:'5 mg',doseQuantity:1,frequencyCode:'QD'}})).status).toBe(409)
    expect((await(await s.request(s.doctor,`${s.path}/clinical`)).json()).orders).toEqual([])
    await addSecondaryInpatientWard(s.runtime)
    const role=await s.runtime.app.request('/api/auth/role',{method:'POST',headers:{cookie:s.doctor,origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({practitionerRoleId:'practitioner-role-inpatient-doctor-surgery'})})
    expect(role.status).toBe(200)
    expect((await s.request(s.doctor,`${s.path}/clinical`)).status).toBe(403)
    const reset=await s.runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',{method:'POST',headers:{cookie:s.admin,origin:'http://localhost','content-type':'application/json','idempotency-key':randomUUID()},body:'{}'})
    expect(reset.status).toBe(200)
    expect((await s.request(s.nurse,`${s.path}/clinical`)).status).toBe(404)
  })

  it('库存投影失败原子回滚余额、发药、费用与执行状态，同一原key可恢复', async () => {
    const s=await setup()
    const diagnosed=await(await s.request(s.doctor,`${s.path}/diagnoses/confirm`,{encounterVersion:s.admission.versionId,expectedRevision:0,entries:[{catalogItemId:'diagnosis-hypertension',role:'primary',admissionCondition:'1'}]})).json()
    const issued=await(await s.request(s.doctor,`${s.path}/orders/issue`,{encounterVersion:diagnosed.data.encounterVersion,duration:'temporary',selection:{kind:'medication',catalogItemId:'medication-amlodipine',catalogVersion:1,doseText:'5 mg',doseQuantity:1,frequencyCode:'QD'}})).json()
    const order=issued.data.orders[0]
    const checked=await(await s.request(s.nurse,`${s.path}/orders/verify`,{orderId:order.id,expectedOrderVersion:order.version})).json()
    const execution=checked.data.executions[0],catalog=inpatientFullCatalogSchema.parse(await(await s.request(s.doctor,'/api/his/v1/inpatient/clinical-catalog')).json())
    const lot=catalog.medications.find(item=>item.id==='medication-amlodipine')!.lots[0]!
    const input={executionId:execution.id,expectedExecutionVersion:execution.version,lotSelections:[{lotId:lot.id,expectedVersion:lot.version,quantity:1}]},key=randomUUID()
    s.runtime.database.driver.exec(`CREATE TRIGGER reject_inpatient_inventory BEFORE UPDATE ON fhir_resource WHEN NEW.resource_type='InventoryItem' BEGIN SELECT RAISE(ABORT,'synthetic inventory projection failure'); END`)
    try {
      expect((await s.request(s.pharmacist,`${s.path}/executions/dispense`,input,key)).status).toBe(500)
      const after=inpatientFullClinicalSchema.parse(await(await s.request(s.doctor,`${s.path}/clinical`)).json())
      expect(after.dispenses).toEqual([]);expect(after.charges).toEqual([]);expect(after.executions[0]).toMatchObject({status:'pending',version:1})
      const current=inpatientFullCatalogSchema.parse(await(await s.request(s.doctor,'/api/his/v1/inpatient/clinical-catalog')).json())
      expect(current.medications.find(item=>item.id==='medication-amlodipine')!.lots[0]).toEqual(lot)
      expect(fhirResourceSchema.parse(await(await s.request(s.pharmacist,`/fhir/R5/InventoryItem/${lot.id}`)).json())).toMatchObject({netContent:{value:lot.quantityOnHand},meta:{versionId:String(lot.version)}})
    } finally {s.runtime.database.driver.exec('DROP TRIGGER reject_inpatient_inventory')}
    expect((await s.request(s.pharmacist,`${s.path}/executions/dispense`,input,key)).status).toBe(200)
    expect((await s.request(s.pharmacist,`${s.path}/executions/dispense`,input)).status).toBe(409)
  })

  it('住院诊断病情必须显式四值选择，确认保留次诊断顺序和独立修订', async () => {
    const s=await setup()
    let version=s.admission.versionId,revision=0
    const entries=[{catalogItemId:'diagnosis-hypertension',role:'primary',admissionCondition:'1'},
      {catalogItemId:'diagnosis-fever',role:'secondary',admissionCondition:'3'},
      {catalogItemId:'diagnosis-type-2-diabetes-hyperglycemia',role:'secondary',admissionCondition:'2'}]
    for(const admissionCondition of ['0','5','有','']) expect((await s.request(s.doctor,`${s.path}/diagnoses/confirm`,{encounterVersion:version,expectedRevision:revision,entries:[{...entries[0],admissionCondition}]})).status).toBe(400)
    for(const admissionCondition of ['1','2','3','4']) {
      entries[0]!.admissionCondition=admissionCondition
      const response=await s.request(s.doctor,`${s.path}/diagnoses/confirm`,{encounterVersion:version,expectedRevision:revision,entries})
      expect(response.status).toBe(200)
      const confirmed=inpatientFullClinicalResponseSchema.parse(await response.json()).data
      expect(confirmed.diagnosis.entries.map(entry=>entry.coding.id)).toEqual(entries.map(entry=>entry.catalogItemId))
      expect(confirmed.diagnosis.entries[0]).toMatchObject({admissionCondition,ordinal:1})
      expect(confirmed.diagnosis.entries[1]).toMatchObject({admissionCondition:'3',ordinal:2})
      version=confirmed.encounterVersion;revision+=1
    }
    expect((await(await s.request(s.doctor,`${s.path}/clinical`)).json()).diagnosis.revision).toBe(4)
  })

  it('两次住院争用同一批次只有一个CAS成功，门诊药房立即读到住院消耗', async () => {
    const s=await setup()
    const second=inpatientCommandResponseSchema.parse(await(await s.request(s.registrar,'/api/his/v1/inpatient/admissions',{expectedEpoch:'epoch-1',patientId:s.patient.id,patientVersion:s.patient.versionId,admissionRoute:'direct',wardId:'ward-general',depositFen:0})).json()).data.admission
    const received=inpatientCommandResponseSchema.parse(await(await s.request(s.nurse,`/api/his/v1/inpatient/admissions/${second.id}/receive`,{encounterVersion:second.versionId,bedId:'bed-general-2'})).json()).data.admission
    const targets=[]
    for(const admission of [s.admission,received]) {
      const path=`/api/his/v1/inpatient/admissions/${admission.id}`
      const diagnosed=inpatientFullClinicalResponseSchema.parse(await(await s.request(s.doctor,`${path}/diagnoses/confirm`,{encounterVersion:admission.versionId,expectedRevision:0,entries:[{catalogItemId:'diagnosis-hypertension',role:'primary',admissionCondition:'1'}]})).json()).data
      const issued=inpatientFullClinicalResponseSchema.parse(await(await s.request(s.doctor,`${path}/orders/issue`,{encounterVersion:diagnosed.encounterVersion,duration:'temporary',selection:{kind:'medication',catalogItemId:'medication-amlodipine',catalogVersion:1,doseText:'5 mg',doseQuantity:1,frequencyCode:'QD'}})).json()).data
      const order=issued.orders[0]!
      const verified=inpatientFullClinicalResponseSchema.parse(await(await s.request(s.nurse,`${path}/orders/verify`,{orderId:order.id,expectedOrderVersion:order.version})).json()).data
      targets.push({path,execution:verified.executions[0]!})
    }
    await paidOutpatient(s)
    const catalog=inpatientFullCatalogSchema.parse(await(await s.request(s.doctor,'/api/his/v1/inpatient/clinical-catalog')).json()),lot=catalog.medications.find(item=>item.id==='medication-amlodipine')!.lots[0]!
    const results=await Promise.all(targets.map(target=>s.request(s.pharmacist,`${target.path}/executions/dispense`,{executionId:target.execution.id,expectedExecutionVersion:target.execution.version,lotSelections:[{lotId:lot.id,expectedVersion:lot.version,quantity:1}]})))
    expect(results.map(response=>response.status).sort()).toEqual([200,409])
    const queue=pharmacyQueueSchema.parse(await(await s.request(s.pharmacist,'/api/his/v1/pharmacy/queue')).json())
    expect(queue.items[0]!.medications[0]!.lots[0]).toMatchObject({id:lot.id,quantityOnHand:lot.quantityOnHand-1,version:lot.version+1})
    const pending=queue.items[0]!,medication=pending.medications[0]!,versions={ [`Encounter/${pending.encounterId}`]:pending.encounterVersion,[`MedicationRequest/${medication.medicationRequestId}`]:medication.medicationRequestVersion }
    const mutate=(path:string,body:unknown)=>s.runtime.app.request(path,{method:'POST',headers:{cookie:s.pharmacist,origin:'http://localhost','content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(body)})
    const review=await mutate(`/api/his/v1/prescriptions/${pending.prescriptionId}/actions/review`,{expectedVersions:versions,input:{expectedPrescriptionVersion:pending.prescriptionVersion,note:'合成门诊审方'}})
    expect(review.status).toBe(200)
    const reviewed=prescriptionReviewResponseSchema.parse(await review.json()).data
    const dispensed=await mutate(`/api/his/v1/prescriptions/${pending.prescriptionId}/actions/dispense`,{expectedVersions:versions,input:{expectedPrescriptionVersion:reviewed.prescriptionVersion,lotSelections:[{lotId:lot.id,expectedVersion:lot.version+1,quantity:30}]}})
    expect(dispensed.status).toBe(200)
    expect(dispenseResponseSchema.parse(await dispensed.json()).data.scenarioStatus).toBe('active')
    const stillActive=await s.request(s.doctor,`${s.path}/clinical`)
    expect(stillActive.status).toBe(200)
    const clinical=inpatientFullClinicalSchema.parse(await stillActive.json())
    expect((await s.request(s.doctor,`${s.path}/orders/issue`,{encounterVersion:clinical.encounterVersion,duration:'temporary',selection:{kind:'service',serviceId:'hospital-service-diabetes-education',serviceVersion:1,quantity:1}})).status).toBe(200)

  })

  it('频次表重建保留非空医嘱、执行与引用索引，并开放六种频次约束', async () => {
    const s = await setup()
    const diagnosed = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
      encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }],
    })).json()).data
    const issued = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/orders/issue`, {
      encounterVersion: diagnosed.encounterVersion, duration: 'temporary',
      selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' },
    })).json()).data.orders[0]!
    expect((await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: issued.id, expectedOrderVersion: issued.version })).status).toBe(200)
    await s.runtime.close()
    const database = openClinMeshDatabase({ databasePath: s.databasePath, busyTimeoutMs: 5000 })
    try {
      const orders = database.driver.prepare('SELECT * FROM inpatient_order').all()
      const executions = database.driver.prepare('SELECT * FROM inpatient_execution').all()
      // 还原同一表在 0112 前的三个频次约束，保留真实业务行和下游外键。
      database.driver.pragma('foreign_keys=OFF')
      const rebuild = await readFile('drizzle/0112_medication-frequency.sql', 'utf8')
      database.driver.exec(rebuild.replace("'QD','BID','TID','QN','PRN','ONCE'", "'QD','BID','PRN'"))
      database.driver.prepare('DELETE FROM schema_migration WHERE migration_id=?').run('0112_medication-frequency.sql')
      database.driver.pragma('foreign_keys=ON')
      expect(() => database.driver.prepare("UPDATE inpatient_order SET frequency_code='TID'").run()).toThrow(/CHECK/)
      expect(applyMigrations(database, 'drizzle').applied).toEqual(['0112_medication-frequency.sql'])
      expect(database.driver.prepare('SELECT * FROM inpatient_order').all()).toEqual(orders)
      expect(database.driver.prepare('SELECT * FROM inpatient_execution').all()).toEqual(executions)
      for (const frequency of ['QD', 'BID', 'TID', 'QN', 'PRN', 'ONCE']) expect(() => database.driver.prepare('UPDATE inpatient_order SET frequency_code=?').run(frequency)).not.toThrow()
      expect(() => database.driver.prepare("UPDATE inpatient_order SET frequency_code='Q4H'").run()).toThrow(/CHECK/)
      expect(database.driver.pragma('foreign_key_check')).toEqual([])
      expect(database.driver.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name='inpatient_order_admission_identity'").get()).toBeDefined()
    } finally { database.close() }
  })

  it('从77旧库升级保留非空门诊库存移动和床费及FHIR历史，来源XOR和原外键继续有效',async()=>{
    const s=await setup(),outpatient=await paidOutpatient(s),lotId='lot-amlodipine-synthetic-001'
    const clock=await(await s.request(s.admin,'/api/sim/v1/scenario-runs/current')).json()
    expect((await s.request(s.admin,'/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time',{expectedVirtualTime:clock.virtualTime,targetVirtualTime:'2026-08-25T01:00:00.000Z'})).status).toBe(200)
    s.runtime.database.driver.prepare('INSERT INTO inventory_movement(workspace_id,epoch,movement_id,prescription_id,lot_id,quantity,occurred_at) VALUES(?,?,?,?,?,3,?)').run(outpatient.context.workspaceId,outpatient.context.epoch,'legacy-movement',outpatient.id,lotId,clock.virtualTime)
    await s.runtime.close()
    const migrations=join(s.directory,'legacy-migrations');await mkdir(migrations)
    for(const file of (await readdir('drizzle')).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name<'0070_'&&name!=='0069_registration-numbering.sql')) await copyFile(join('drizzle',file),join(migrations,file))
    const legacy=openClinMeshDatabase({databasePath:join(s.directory,'legacy.sqlite'),busyTimeoutMs:5000})
    try {
      expect(applyMigrations(legacy,migrations).schemaVersion).toBe(77)
      legacy.driver.pragma('foreign_keys = OFF');legacy.driver.prepare('ATTACH DATABASE ? AS captured').run(s.databasePath)
      const tables=z.array(z.object({name:z.string()})).parse(legacy.driver.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migration'").all())
      legacy.driver.exec('BEGIN')
      for(const {name} of tables) {
        if (isRetiredCapturedPaymentTable(legacy, name)) continue
        const quoted=`"${name.replaceAll('"','""')}"`,columns=z.array(z.object({name:z.string()})).parse(legacy.driver.pragma(`table_info(${quoted})`)),list=columns.map(column=>`"${column.name.replaceAll('"','""')}"`).join(',')
        // 医保办岗位是 81 迁移新增，77 旧枚举不容纳；升级回归只搬 77 已有岗位行。
        const source=name==='practitioner_role_binding'?"(SELECT * FROM captured.practitioner_role_binding WHERE role_code NOT IN ('medical-insurance'))":`captured.${quoted}`
        legacy.driver.exec(`INSERT OR REPLACE INTO ${quoted}(${list}) SELECT ${list} FROM ${source}`)
      }
      // 成员引用跟着岗位走：清掉指向未搬入岗位（81 新增枚举外）的成员行，保持旧库引用完整。
      legacy.driver.prepare(`DELETE FROM membership_practitioner_role WHERE (workspace_id,practitioner_role_id) NOT IN (SELECT workspace_id,practitioner_role_id FROM practitioner_role_binding)`).run()
      legacy.driver.exec('COMMIT');legacy.driver.exec('DETACH DATABASE captured');legacy.driver.pragma('foreign_keys = ON')
      expect(legacy.driver.pragma('foreign_key_check')).toEqual([])
      const historicalMigrations=prePaymentCutoverMigrations(legacy)
      expect(applyMigrations(legacy,historicalMigrations)).toMatchObject({applied:[
        '0069_registration-numbering.sql', '0070_doctor-recommendation-consolidation-stage.sql', '0070_inpatient-orders.sql',
        '0071_inpatient-investigations-transfer.sql', '0071_model-usage.sql', '0071_payment-installments.sql',
        '0072_inpatient-surgery.sql', '0072_model-usage-control.sql', '0072_payment-history-pagination.sql',
        '0073_inpatient-discharge.sql', '0073_model-task-recovery.sql', '0074_host-model-waiting.sql', '0074_inpatient-record.sql',
        '0075_model-usage-dimensions.sql',
        '0075_payment-refunds.sql',
        '0075_refund-tenders.sql',
        '0076_inpatient-payments.sql',
        '0076_model-usage-retention.sql',
        '0077_inpatient-financial-adjustments.sql',
        '0077_model-usage-token-breakdown.sql',
        '0078_inpatient-material-reservation.sql',
        '0078_model-task-invalid-code.sql',
        '0079_doctor-consideration-disposition.sql',
        '0080_inpatient-record-archive-drg.sql',
        '0081_inpatient-drg-payer-review.sql',
        '0082_practitioner-role-medical-insurance.sql',
        '0090_insurance-benefits.sql',
        '0091_inpatient-insurance-adjustments.sql',
        '0092_authored-case-source.sql',
        '0092_outpatient-investigation-billing.sql',
        '0093_outpatient-investigation-draft-price.sql',
        '0093_synthetic-inpatient-case-materialization.sql',
        '0094_authored-exact-investigation.sql',
        '0095_inpatient-pci-selection.sql',
        '0096_inpatient-drg-followup.sql',
        '0097_model-usage-task-dimensions.sql',
        '0098_inpatient-drg-agent.sql',
        '0099_inpatient-surgery-material-events.sql', '0100_inpatient-drg-review.sql', '0101_inpatient-material-estimate.sql', '0101_shared-payment-collection.sql', '0102_inpatient-payment-collection.sql', '0102_surgery-reservation-completion-policy.sql',
      ],schemaVersion:expectedSchemaVersion(historicalMigrations)})
      expect(legacy.driver.prepare('SELECT prescription_id,inpatient_dispense_id,quantity FROM inventory_movement WHERE movement_id=?').get('legacy-movement')).toEqual({prescription_id:outpatient.id,inpatient_dispense_id:null,quantity:3})
      expect(legacy.driver.prepare('SELECT amount_fen FROM inpatient_charge WHERE admission_id=?').get(s.admission.id)).toEqual({amount_fen:5000})
      expect(legacy.driver.prepare("SELECT COUNT(*) count FROM fhir_history WHERE resource_type='MedicationRequest' AND resource_id='synthetic-outpatient-medication-request'").get()).toEqual({count:1})
      expect(()=>legacy.driver.prepare('DELETE FROM prescription WHERE prescription_id=?').run(outpatient.id)).toThrow(/FOREIGN KEY/)
      expect(()=>legacy.driver.prepare('INSERT INTO inventory_movement(workspace_id,epoch,movement_id,lot_id,quantity,occurred_at) VALUES(?,?,?,?,1,?)').run(outpatient.context.workspaceId,outpatient.context.epoch,'invalid-movement',lotId,clock.virtualTime)).toThrow(/CHECK/)
      expect(legacy.driver.pragma('foreign_key_check')).toEqual([])
    } finally {legacy.close()}
  })

  it('心血管跨类联合医嘱可校对，药理互斥、极量和长期 ONCE 返回结构化拒绝', async () => {
    const s = await setup()
    const diagnosed = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
      encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-coronary-heart-disease', role: 'primary', admissionCondition: '1' },
        { catalogItemId: 'diagnosis-hypertension', role: 'secondary', admissionCondition: '1' }],
    })).json()).data
    const issue = async (id: string, doseText: string, quantity: number, frequencyCode = 'QD', duration = 'long') => s.request(s.doctor, `${s.path}/orders/issue`, {
      encounterVersion: diagnosed.encounterVersion, duration, selection: { kind: 'medication', catalogItemId: id, catalogVersion: 1, doseText, doseQuantity: quantity, frequencyCode },
    })
    for (const [id, doseText, quantity, frequency] of [
      ['medication-pci-aspirin', '100 mg', 1, 'QD'], ['medication-pci-clopidogrel', '75 mg', 1, 'QD'],
      ['medication-pci-atorvastatin', '20 mg', 2, 'QN'], ['medication-metoprolol', '47.5 mg', 1, 'QD'], ['medication-perindopril', '4 mg', 1, 'QD'],
    ] as const) {
      const response = await issue(id, doseText, quantity, frequency)
      expect(response.status, await response.clone().text()).toBe(200)
      const order = inpatientFullClinicalResponseSchema.parse(await response.json()).data.orders.find(item => item.catalogItemId === id)!
      expect((await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).status).toBe(200)
    }
    for (const [id, dose, quantity, frequency, reason] of [
      ['medication-ticagrelor', '90 mg', 1, 'BID', 'MEDICATION_COMBINATION_NOT_ALLOWED'],
      ['medication-rosuvastatin', '10 mg', 1, 'QN', 'MEDICATION_COMBINATION_NOT_ALLOWED'],
      ['medication-valsartan', '80 mg', 1, 'QD', 'MEDICATION_COMBINATION_NOT_ALLOWED'],
      ['medication-amlodipine', '15 mg', 3, 'QD', 'MEDICATION_DOSAGE_NOT_ALLOWED'],
      ['medication-amlodipine', '10 mg', 2, 'BID', 'MEDICATION_DOSAGE_NOT_ALLOWED'],
      ['medication-amoxicillin', '500 mg', 1, 'TID', 'MEDICATION_DIAGNOSIS_NOT_ALLOWED'],
      ['medication-pci-heparin', '1 mL', 1, 'ONCE', 'MEDICATION_ONCE_REQUIRES_TEMPORARY'],
    ] as const) {
      const rejected = await issue(id, dose, quantity, frequency)
      expect(rejected.status).toBe(409)
      expect(await rejected.json()).toMatchObject({ error: { reason } })
    }
    const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
    expect(clinical.orders).toHaveLength(5)
    expect(clinical.executions.find(item => item.orderId === clinical.orders.find(order => order.catalogItemId === 'medication-pci-atorvastatin')!.id)?.scheduledFor).toBe('2026-08-24T14:00:00.000Z')
    const heparin = await issue('medication-pci-heparin', '6250 IU', 1, 'PRN')
    expect(heparin.status, await heparin.clone().text()).toBe(200)
    expect(inpatientFullClinicalResponseSchema.parse(await heparin.json()).data.orders.find(item => item.catalogItemId === 'medication-pci-heparin')).toMatchObject({ doseText: '6250 IU', doseQuantity: 1, unit: 'mL' })
  })

  it.each([
    ['TID', 'medication-metformin', '0.5 g', 'diagnosis-type-2-diabetes-hyperglycemia', ['2026-08-24T06:00:00.000Z', '2026-08-24T12:00:00.000Z']],
    ['QN', 'medication-pci-atorvastatin', '10 mg', 'diagnosis-coronary-heart-disease', ['2026-08-24T14:00:00.000Z']],
    ['ONCE', 'medication-amlodipine', '5 mg', 'diagnosis-hypertension', ['2026-08-24T09:00:00+08:00']],
  ] as const)('%s 频次按声明时点排程且临时 ONCE 只生成一次', async (frequencyCode, id, doseText, diagnosis, scheduled) => {
    const s = await setup()
    const diagnosed = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
      encounterVersion: s.admission.versionId, expectedRevision: 0, entries: [{ catalogItemId: diagnosis, role: 'primary', admissionCondition: '1' }],
    })).json()).data
    const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: diagnosed.encounterVersion, duration: frequencyCode === 'ONCE' ? 'temporary' : 'long',
      selection: { kind: 'medication', catalogItemId: id, catalogVersion: 1, doseText, doseQuantity: 1, frequencyCode } })
    expect(issued.status, await issued.clone().text()).toBe(200)
    const order = inpatientFullClinicalResponseSchema.parse(await issued.json()).data.orders[0]!
    const verified = inpatientFullClinicalResponseSchema.parse(await (await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })).json()).data
    expect(verified.executions.map(item => item.scheduledFor)).toEqual(scheduled)
    const clock = scenarioStateSchema.parse(await (await s.request(s.admin, '/api/sim/v1/scenario-runs/current')).json())
    expect((await s.request(s.admin, `/api/sim/v1/scenario-runs/${clock.scenarioRunId}/actions/advance-time`, { expectedVirtualTime: clock.virtualTime, targetVirtualTime: '2026-08-25T01:00:00.000Z' })).status).toBe(200)
    const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
    expect(clinical.executions).toHaveLength(frequencyCode === 'TID' ? 5 : frequencyCode === 'QN' ? 2 : 1)
  })

  it('住院服务私有计费定义不会污染门诊服务目录响应合同',async()=>{
    const s=await setup()
    const response=await s.request(s.admin,'/api/his/v1/catalogs/services?page=1&pageSize=100')
    expect(response.status).toBe(200)
    const catalog=serviceCatalogSearchSchema.parse(await response.json())
    expect(catalog.items.find(item=>item.id==='hospital-service-diabetes-education')).toMatchObject({chargeDefinition:{priceFen:3000}})
    expect(JSON.stringify(catalog)).not.toContain('inpatientBillingTrigger')
  })

})
