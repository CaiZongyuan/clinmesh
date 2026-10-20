import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-surgery-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
  const runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key = randomUUID()) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': key }, ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  }
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), cashier = await login('cashier')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成手术患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  const patient = (await created.json()).data.patient
  const registered = (await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const admission = (await (await request(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1' })).json()).data.admission
  return { runtime, options, request, login, patient, admission, doctor, nurse, cashier, registrar, path: `/api/his/v1/inpatient/admissions/${admission.id}` }
}

describe('住院手术公共 HTTP 与真实 SQLite', () => {
  it('双准备门禁，计划与实际独立，执行和费用原子且原键重放', async () => {
    const s = await setup()
    const catalogResponse = await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')
    expect(catalogResponse.status).toBe(200)
    const catalog = await catalogResponse.json()
    expect(catalog.procedures.map((item: { coding: { code: string } }) => item.coding.code)).toContain('00.6600x008')
    const planned = catalog.procedures.find((item: { coding: { code: string } }) => item.coding.code === '47.0100')
    const actual = catalog.procedures.find((item: { coding: { code: string } }) => item.coding.code === '51.2300')
    const material = catalog.materials[0]
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: s.admission.versionId,
      procedureId: planned.id, catalogVersion: planned.version, plannedFor: '2026-08-25T01:00:00.000Z', reason: '合成示教手术申请' })
    expect(requested.status).toBe(200)
    let state = (await requested.json()).data
    const id = state.requests[0].id
    const execute = () => ({ requestId: id, expectedRequestVersion: state.requests[0].version, procedureId: actual.id,
      catalogVersion: actual.version, note: '实际实施术式与计划不同', materials: [{ materialId: material.id, catalogVersion: material.version, quantity: 2 }] })
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, execute())).status).toBe(409)
    expect(state.executions).toEqual([])
    const checked = await s.request(s.nurse, `${s.path}/surgeries/check-preop`, { requestId: id, expectedRequestVersion: state.requests[0].version, note: '已核对术前检查' })
    expect(checked.status).toBe(200)
    state = (await checked.json()).data
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, execute())).status).toBe(409)
    const consent = await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, { requestId: id, expectedRequestVersion: state.requests[0].version, note: '确认已签署知情同意书' })
    expect(consent.status).toBe(200)
    state = (await consent.json()).data
    expect(state.requests[0].status).toBe('ready')
    const key = randomUUID(), input = execute()
    const completed = await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)
    expect(completed.status).toBe(200)
    const body = await completed.json()
    expect(await (await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)).json()).toEqual(body)
    state = body.data
    expect(state.executions).toHaveLength(1)
    expect(state.requests[0].plannedProcedure.coding.code).toBe('47.0100')
    expect(state.executions[0]).toMatchObject({ requestId: id, actualProcedure: { coding: { code: '51.2300' } }, materials: [{ quantity: 2 }] })
    const procedures = await (await s.request(s.doctor, `/fhir/R5/Procedure?encounter=Encounter/${s.admission.id}&_total=accurate`)).json()
    expect(procedures.total).toBe(1)
    const metadata = await (await s.request(s.doctor, '/fhir/R5/metadata')).json()
    const capability = metadata.rest[0].resource.find((item: { type: string }) => item.type === 'Procedure')
    expect(capability.interaction.map((item: { code: string }) => item.code)).toEqual(['read','vread','history-instance','search-type'])
    expect(capability.searchParam.map((item: { name: string }) => item.name)).toEqual(['patient','encounter'])
    expect((await s.request(s.doctor, '/fhir/R5/Procedure?status=completed')).status).toBe(400)
    expect((await (await s.request(s.doctor, `/fhir/R5/Procedure?patient=Patient/${s.patient.id}&_total=accurate`)).json()).total).toBe(1)
    expect(procedures.entry[0].resource).toMatchObject({ status: 'completed', code: { coding: [{ code: '51.2300' }] },
      subject: { reference: `Patient/${s.patient.id}` }, basedOn: [{ reference: `ServiceRequest/${id}` }] })
    const ledger = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    expect(ledger.charges.map((charge: { kind: string; amountFen: number }) => ({ kind: charge.kind, amountFen: charge.amountFen }))).toEqual([
      { kind: 'surgery', amountFen: actual.chargeDefinition.priceFen }, { kind: 'material', amountFen: material.chargeDefinition.priceFen * 2 }])
    expect((await s.request(s.doctor, `${s.path}/surgeries/cancel`, { requestId: id, expectedRequestVersion: state.requests[0].version, note: '不能取消已实施事实' })).status).toBe(409)
  })

  it('岗位、当前病区、目录身份、旧版本和取消竞争均受门禁', async () => {
    const s = await setup()
    const request = { encounterVersion: s.admission.versionId, procedureId: 'hospital-surgery-1', catalogVersion: 1,
      plannedFor: '2026-08-25T01:00:00.000Z', reason: '合成申请' }
    expect((await s.request(s.nurse, `${s.path}/surgeries/request`, request)).status).toBe(403)
    expect((await s.request(s.cashier, `${s.path}/surgeries`)).status).toBe(403)
    for (const value of [{ ...request, procedureId: '00.6600' }, { ...request, catalogVersion: 999 }, { ...request, plannedFor: '2026-01-01T00:00:00Z' }]) {
      expect((await s.request(s.doctor, `${s.path}/surgeries/request`, value)).status).toBe(409)
    }
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, request)
    expect(requested.status).toBe(200)
    const row = (await requested.json()).data.requests[0]
    const action = { requestId: row.id, expectedRequestVersion: row.version, note: '确认已签署' }
    expect((await s.request(s.nurse, `${s.path}/surgeries/confirm-consent`, action)).status).toBe(403)
    expect((await s.request(s.doctor, `${s.path}/surgeries/check-preop`, action)).status).toBe(403)
    const consent = await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, action)
    expect(consent.status).toBe(200)
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, { ...action, expectedRequestVersion: 2, ...request, materials: [] })).status).toBe(400)
    const execution = { requestId: row.id, expectedRequestVersion: 2, procedureId: 'hospital-surgery-1', catalogVersion: 1, materials: [], note: '仅同意未核对不能执行' }
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, execution)).status).toBe(409)
    expect((await s.request(s.nurse, `${s.path}/surgeries/check-preop`, action)).status).toBe(409)
    const switched = await s.runtime.app.request('/api/auth/role', { method: 'POST', headers: { cookie: s.nurse, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-ward-nurse-surgery' }) })
    expect(switched.status).toBe(200)
    expect((await s.request(s.nurse, `${s.path}/surgeries`)).status).toBe(403)
    const cancelInput = { requestId: row.id, expectedRequestVersion: 2, note: '取消合成未实施计划' }
    const race = await Promise.all([s.request(s.doctor, `${s.path}/surgeries/cancel`, cancelInput), s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, cancelInput)])
    expect(race.map(result => result.status).sort()).toEqual([200,409])
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, { ...execution, expectedRequestVersion: 3 })).status).toBe(409)
    const final = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    expect(final.executions).toEqual([])
    expect(final.requests[0]).toMatchObject({ status: 'cancelled', consentConfirmation: { note: '确认已签署' }, cancellation: { note: '取消合成未实施计划' } })
  })

  it.each(['projection','billing'])('%s 写入失败回滚实施、耗材和费用，原键可安全重试', async failure => {
    const s = await setup(), state = await readySurgery(s, false), row = state.requests[0]
    const input = { requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1,
      materials: [{ materialId: 'hospital-material-suture', catalogVersion: 1, quantity: 2 }], note: '失败后不留部分事实' }
    const key = randomUUID()
    s.runtime.database.driver.exec(failure === 'projection'
      ? "CREATE TRIGGER fail_surgery BEFORE INSERT ON fhir_resource WHEN NEW.resource_type='Procedure' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;"
      : "CREATE TRIGGER fail_surgery BEFORE INSERT ON inpatient_charge WHEN NEW.kind='material' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;")
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)).status).toBe(500)
    const failed = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    expect(failed.executions).toEqual([])
    expect(failed.requests[0].status).toBe('ready')
    expect((await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges).toEqual([])
    const procedures = await (await s.request(s.doctor, `/fhir/R5/Procedure?encounter=Encounter/${s.admission.id}&_total=accurate`)).json()
    expect(procedures.total).toBe(0)
    s.runtime.database.driver.exec('DROP TRIGGER fail_surgery')
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)).status).toBe(200)
    expect((await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(204000)
  })

  it('已就绪申请的取消与实施竞争只提交一个结局', async () => {
    const s = await setup(), state = await readySurgery(s, false), row = state.requests[0]
    const common = { requestId: row.id, expectedRequestVersion: row.version, note: '合成取消与实施竞争' }
    const responses = await Promise.all([
      s.request(s.doctor, `${s.path}/surgeries/execute`, { ...common, procedureId: 'hospital-surgery-4', catalogVersion: 1, materials: [] }),
      s.request(s.doctor, `${s.path}/surgeries/cancel`, common),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200,409])
    const final = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    const ledger = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    if (final.requests[0].status === 'completed') {
      expect(final.executions).toHaveLength(1)
      expect(ledger.chargesFen).toBe(200000)
    } else {
      expect(final.requests[0].status).toBe('cancelled')
      expect(final.executions).toEqual([])
      expect(ledger.charges).toEqual([])
    }
  })

  it('已有Epoch重启只补缺失目录，不覆盖已冻结的院内配置', async () => {
    const s = await setup()
    s.runtime.database.driver.exec("DELETE FROM inpatient_surgery_catalog WHERE item_id='hospital-material-catheter'")
    s.runtime.database.driver.exec("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.priceFen',123456) WHERE item_id='hospital-surgery-4'")
    await s.runtime.close()
    const reopened = await createClinMeshRuntime(s.options)
    cleanups.push(() => reopened.close())
    const response = await reopened.app.request('/api/his/v1/inpatient/surgery-catalog', { headers: { cookie:s.doctor } })
    expect(response.status).toBe(200)
    const catalog = await response.json()
    expect(catalog.procedures).toHaveLength(8)
    expect(catalog.materials).toHaveLength(2)
    expect(catalog.procedures.find((item: { id: string }) => item.id === 'hospital-surgery-4').chargeDefinition.priceFen).toBe(123456)
  })

  it('术后医嘱只接受本次已实施事实并仍须护士校对', async () => {
    const s = await setup()
    const input = { encounterVersion: s.admission.versionId, duration: 'temporary', surgeryExecutionId: 'missing',
      selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } }
    const rejected = await s.request(s.doctor, `${s.path}/orders/issue`, input)
    expect(rejected.status).toBe(409)
    expect((await rejected.json()).error.code).toBe('INPATIENT_SURGERY_EXECUTION_REQUIRED')
    const state = await readySurgery(s)
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, surgeryExecutionId: state.requests[0].id })).status).toBe(409)
    const createdOther = await s.runtime.app.request('/api/his/v1/patients', { method:'POST', headers:{cookie:s.registrar,origin:'http://localhost','content-type':'application/json','idempotency-key':randomUUID()},
      body:JSON.stringify({expectedVersions:{},input:{name:'合成其他住院患者',gender:'male',birthDate:'1980-01-01',identifier:`SYN-${randomUUID()}`}}) })
    expect(createdOther.status).toBe(200)
    const otherPatient = (await createdOther.json()).data.patient
    const registeredOther = await s.request(s.registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch:'epoch-1',patientId:otherPatient.id,
      patientVersion:otherPatient.versionId,admissionRoute:'direct',wardId:'ward-general',depositFen:0 })
    const other = (await registeredOther.json()).data.admission
    const receivedOther = await s.request(s.nurse, `/api/his/v1/inpatient/admissions/${other.id}/receive`, { encounterVersion:other.versionId,bedId:'bed-general-2' })
    expect(receivedOther.status).toBe(200)
    const foreign = await s.request(s.doctor, `/api/his/v1/inpatient/admissions/${other.id}/orders/issue`, { ...input,
      encounterVersion:(await receivedOther.json()).data.admission.versionId,surgeryExecutionId:state.executions[0].id })
    expect(foreign.status).toBe(409)
    expect((await foreign.json()).error.code).toBe('INPATIENT_SURGERY_EXECUTION_REQUIRED')
    const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, surgeryExecutionId: state.executions[0].id })
    expect(issued.status).toBe(200)
    let clinical = (await issued.json()).data
    expect(clinical.orders[0]).toMatchObject({ surgeryExecutionId: state.executions[0].id, state: 'signed' })
    expect(clinical.executions).toEqual([])
    const requestResource = await (await s.request(s.doctor, `/fhir/R5/ServiceRequest/${clinical.orders[0].id}`)).json()
    expect(requestResource.supportingInfo).toEqual([{ reference: { reference: `Procedure/${state.executions[0].id}` } }])
    expect(requestResource).not.toHaveProperty('supportingInformation')
    const verified = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: clinical.orders[0].id, expectedOrderVersion: 1 })
    expect(verified.status).toBe(200)
    clinical = (await verified.json()).data
    expect(clinical.executions[0].status).toBe('pending')
    const diagnosis = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }] })
    expect(diagnosis.status).toBe(200)
    const medication = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: (await diagnosis.json()).data.encounterVersion,
      duration: 'temporary', surgeryExecutionId: state.executions[0].id, selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1,
        doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })
    expect(medication.status).toBe(200)
    const medicationOrder = (await medication.json()).data.orders.find((item: { kind: string }) => item.kind === 'medication')
    const medicationRequest = await (await s.request(s.doctor, `/fhir/R5/MedicationRequest/${medicationOrder.id}`)).json()
    expect(medicationRequest.supportingInformation).toEqual([{ reference: `Procedure/${state.executions[0].id}` }])
    const checkedMedication = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: medicationOrder.id, expectedOrderVersion: 1 })
    expect(checkedMedication.status).toBe(200)
    const execution = (await checkedMedication.json()).data.executions.find((item: { orderId: string }) => item.orderId === medicationOrder.id)
    expect((await s.request(s.nurse, `${s.path}/executions/administer`, { executionId: execution.id, expectedExecutionVersion: execution.version })).status).toBe(409)
  })

})

async function readySurgery(s: Awaited<ReturnType<typeof setup>>, complete = true) {
  const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: s.admission.versionId,
    procedureId: 'hospital-surgery-4', catalogVersion: 1, plannedFor: '2026-08-25T01:00:00.000Z', reason: '合成手术测试' })
  expect(requested.status).toBe(200)
  let state = (await requested.json()).data
  const id = state.requests.at(-1).id
  const checked = await s.request(s.nurse, `${s.path}/surgeries/check-preop`, { requestId: id, expectedRequestVersion: 1, note: '已核对检查' })
  expect(checked.status).toBe(200)
  const consent = await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, { requestId: id, expectedRequestVersion: 2, note: '确认同意已签署' })
  expect(consent.status).toBe(200)
  state = (await consent.json()).data
  if (complete) {
    const executed = await s.request(s.doctor, `${s.path}/surgeries/execute`, { requestId: id, expectedRequestVersion: 3,
      procedureId: 'hospital-surgery-4', catalogVersion: 1, materials: [], note: '合成实际实施' })
    expect(executed.status).toBe(200)
    state = (await executed.json()).data
  }
  return state
}
