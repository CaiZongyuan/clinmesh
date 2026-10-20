import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { inpatientCommandResponseSchema, inpatientListSchema, advanceVirtualTimeResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { registrationResponseSchema, triageResponseSchema, startVisitResponseSchema } from '@clinmesh/contracts/his'
import { openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { agentClientSchema, agentCapabilityGrantSchema } from '@clinmesh/contracts/agent'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'

describe('住院建档与入科 HTTP 合同', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const directories: string[] = []
  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-'))
    directories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtimeOptions: Parameters<typeof createClinMeshRuntime>[0] = { authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
      migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
    const runtime = await createClinMeshRuntime(runtimeOptions)
    runtimes.push(runtime)
    async function login(email: string) {
      const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ email: `${email}@demo.clinmesh.local`, password }) })
      expect(response.status).toBe(200)
      return response.headers.get('set-cookie')!.split(';', 1)[0]!
    }
    async function request(cookie: string, path: string, input?: unknown, key = randomUUID()) {
      return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST',
        headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    }
    const registrar = await login('registrar')
    const patientResponse = await request(registrar, '/api/his/v1/patients', { expectedVersions: {}, input: {
      name: '合成住院患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } })
    expect(patientResponse.status).toBe(200)
    const patient = (await patientResponse.json()).data.patient
    return { runtime, login, request, registrar, patient, databasePath: join(directory, 'hospital.sqlite'),
      reopen: async () => { const reopened = await createClinMeshRuntime(runtimeOptions); runtimes.push(reopened); return reopened } }
  }
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })))
  })

  it('登记员直接入院形成独立住院号，预交金重试只收取一次，管理员不能代办', async () => {
    const { request, login, registrar, patient } = await setup()
    const input = { input: { patientId: patient.id, patientVersion: patient.versionId,
      expectedEpoch: 'epoch-1', admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100_000 } }
    const key = randomUUID()
    const first = await request(registrar, '/api/his/v1/inpatient/admissions', input, key)
    expect(first.status).toBe(200)
    const admission = inpatientCommandResponseSchema.parse(await first.json()).data.admission
    expect(admission).toMatchObject({ patientId: patient.id, status: 'registered', depositFen: 100_000,
      chargesFen: 0, wardId: 'ward-general', financialStatus: 'open', recordStatus: 'open' })
    const replay = await request(registrar, '/api/his/v1/inpatient/admissions', input, key)
    expect(replay.status).toBe(200)
    expect((await replay.json()).data.admission).toEqual(admission)
    expect((await request(registrar, '/api/his/v1/inpatient/admissions', { input: { ...input.input, depositFen: 1 } }, key)).status).toBe(409)
    for (const depositFen of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await request(registrar, '/api/his/v1/inpatient/admissions', { input: { ...input.input, depositFen } })).status).toBe(400)
    }
    expect((await request(registrar, '/api/his/v1/inpatient/admissions', { input: { ...input.input, patientVersion: '999' } })).status).toBe(409)
    const second = await request(registrar, '/api/his/v1/inpatient/admissions', input)
    expect(second.status).toBe(200)
    expect((await second.json()).data.admission.inpatientNumber).not.toBe(admission.inpatientNumber)
    const list = await request(registrar, '/api/his/v1/inpatient/admissions')
    expect(inpatientListSchema.parse(await list.json()).items).toHaveLength(2)
    expect((await request(await login('admin'), '/api/his/v1/inpatient/admissions', input)).status).toBe(403)
  })

  it('病区接诊分床拒绝重复占用，转床与换床原子完成，错误版本或跨病区均保持原床', async () => {
    const { request, login, registrar, patient, databasePath } = await setup()
    const nurse = await login('ward-nurse')
    async function register() {
      const response = await request(registrar, '/api/his/v1/inpatient/admissions', { input: {
        patientId: patient.id, patientVersion: patient.versionId, expectedEpoch: 'epoch-1', admissionRoute: 'direct',
        wardId: 'ward-general', depositFen: 0 } })
      return inpatientCommandResponseSchema.parse(await response.json()).data.admission
    }
    const first = await register()
    const second = await register()
    const receive = (admissionId: string, encounterVersion: string, bedId: string) => request(nurse,
      `/api/his/v1/inpatient/admissions/${admissionId}/receive`, { input: { encounterVersion, bedId } })
    const received = await receive(first.id, first.versionId, 'bed-general-1')
    expect(received.status).toBe(200)
    const a = inpatientCommandResponseSchema.parse(await received.json()).data.admission
    expect(a).toMatchObject({ status: 'admitted', bedId: 'bed-general-1' })
    expect((await receive(second.id, second.versionId, 'bed-general-1')).status).toBe(409)
    const b = inpatientCommandResponseSchema.parse(await (await receive(second.id, second.versionId, 'bed-general-2')).json()).data.admission
    const swap = (otherEncounterVersion: string) => request(nurse, `/api/his/v1/inpatient/admissions/${a.id}/swap-bed`, {
      input: { encounterVersion: a.versionId, otherAdmissionId: b.id, otherEncounterVersion } })
    expect((await swap('999')).status).toBe(409)
    expect((await request(nurse, `/api/his/v1/inpatient/admissions/${a.id}`)).status).toBe(200)
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 100 })
    try {
      database.driver.exec(`CREATE TRIGGER reject_second_bed_projection BEFORE UPDATE ON fhir_resource
        WHEN NEW.resource_type='Encounter' AND NEW.resource_id='${b.id}'
        BEGIN SELECT RAISE(ABORT, 'synthetic projection failure'); END`)
      expect((await swap(b.versionId)).status).toBe(500)
      expect(inpatientDetailSchema.parse(await (await request(nurse, `/api/his/v1/inpatient/admissions/${a.id}`)).json()).admission)
        .toMatchObject({ bedId: 'bed-general-1', versionId: a.versionId })
      expect(inpatientDetailSchema.parse(await (await request(nurse, `/api/his/v1/inpatient/admissions/${b.id}`)).json()).admission)
        .toMatchObject({ bedId: 'bed-general-2', versionId: b.versionId })
    } finally {
      database.driver.exec('DROP TRIGGER reject_second_bed_projection')
      database.close()
    }
    const swapped = await swap(b.versionId)
    expect(swapped.status).toBe(200)
    const after = await swapped.json()
    expect(after.data.admission.bedId).toBe('bed-general-2')
    expect(after.data.otherAdmission.bedId).toBe('bed-general-1')
    const move = (bedId: string) => request(nurse, `/api/his/v1/inpatient/admissions/${a.id}/move-bed`, {
      input: { encounterVersion: after.data.admission.versionId, bedId } })
    expect((await move('bed-surgery-1')).status).toBe(409)
    expect((await move('bed-general-3')).status).toBe(200)
  })

  it('场景控制按上海午夜推进逐日床位费，时钟重试与同日推进不重复收费，业务岗位不能推进', async () => {
    const { request, login, registrar, patient } = await setup()
    const nurse = await login('ward-nurse')
    const admin = await login('admin')
    const registered = await request(registrar, '/api/his/v1/inpatient/admissions', { input: {
      patientId: patient.id, patientVersion: patient.versionId, expectedEpoch: 'epoch-1', admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 } })
    const a = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
    expect((await request(nurse, `/api/his/v1/inpatient/admissions/${a.id}/receive`, {
      input: { encounterVersion: a.versionId, bedId: 'bed-general-1' } })).status).toBe(200)
    const scenario = await (await request(admin, '/api/sim/v1/scenario-runs/current')).json()
    const before = scenario.virtualTime
    const next = new Date(new Date(before).valueOf() + 86_400_000).toISOString()
    const advance = { input: { expectedVirtualTime: before, targetVirtualTime: next } }
    expect((await request(nurse, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', advance)).status).toBe(403)
    const key = randomUUID()
    const response = await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', advance, key)
    expect(response.status).toBe(200)
    const advanced = await response.json()
    expect(advanceVirtualTimeResponseSchema.parse(advanced).data.bedChargesCreated).toBe(1)
    expect(advanced.data.clockRevision).toBe(2)
    expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', advance, key)).status).toBe(200)
    const detail = inpatientDetailSchema.parse(await (await request(nurse, `/api/his/v1/inpatient/admissions/${a.id}`)).json())
    expect(detail.admission.chargesFen).toBe(5000)
    const unchanged = await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { input: { expectedVirtualTime: next, targetVirtualTime: next } })
    expect(advanceVirtualTimeResponseSchema.parse(await unchanged.json()).data.bedChargesCreated).toBe(0)
    expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', advance)).status).toBe(409)
    const tooFar = await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { input: {
      expectedVirtualTime: next, targetVirtualTime: new Date(Date.parse(next) + 367 * 86_400_000).toISOString() } })
    expect(tooFar.status).toBe(400)
    expect((await tooFar.json()).error.code).toBe('VIRTUAL_TIME_ADVANCE_LIMIT')
    expect((await (await request(admin, '/api/sim/v1/scenario-runs/current')).json()).virtualTime).toBe(next)
  })

  it('负责门诊医生开住院证，登记员按证转收且不能重复使用', async () => {
    const { request, login, registrar, patient } = await setup()
    const registered = await request(registrar, '/api/his/v1/registrations/actions/register', {
      expectedVersions: { [`Patient/${patient.id}`]: patient.versionId }, input: { patientId: patient.id,
        departmentId: 'department-general-medicine', locationId: 'location-outpatient', visitDate: '2026-08-24', visitTypeId: 'visit-general' } })
    const registration = registrationResponseSchema.parse(await registered.json()).data
    const triaged = await request(await login('triage'), `/api/his/v1/encounters/${registration.encounterId}/actions/record-triage`, {
      expectedVersions: { [`Encounter/${registration.encounterId}`]: '1', [`Task/${registration.queueTaskId}`]: '1' },
      input: { acuityCode: 'level-3', bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, chiefComplaint: '合成持续发热',
        oxygenSaturationPct: 98, pulseBpm: 90, respirationBpm: 20, temperatureC: 38.0 } })
    const triage = triageResponseSchema.parse(await triaged.json()).data
    const doctor = await login('doctor')
    const started = await request(doctor, `/api/his/v1/encounters/${registration.encounterId}/actions/start-first-visit`, {
      expectedVersions: { [`Encounter/${registration.encounterId}`]: triage.encounterVersion, [`Task/${triage.doctorTaskId}`]: '1' }, input: {} })
    const visit = startVisitResponseSchema.parse(await started.json()).data
    const referred = await request(doctor, '/api/his/v1/inpatient/referrals', { input: { encounterId: registration.encounterId,
      encounterVersion: visit.encounterVersion, wardId: 'ward-general', reason: '持续发热需住院观察' } })
    expect(referred.status).toBe(200)
    const referral = (await referred.json()).data.referral
    const input = { input: { patientId: patient.id, patientVersion: patient.versionId, expectedEpoch: 'epoch-1', admissionRoute: 'outpatient',
      wardId: 'ward-general', referralId: referral.id, depositFen: 200_000 } }
    expect((await request(registrar, '/api/his/v1/inpatient/admissions', input)).status).toBe(200)
    expect((await request(registrar, '/api/his/v1/inpatient/admissions', input)).status).toBe(409)
  })

  it('存量带上海时区的23:30入科事实在次日00:00产生首夜床位费', async () => {
    const { request, login, registrar, patient, databasePath } = await setup()
    const nurse = await login('ward-nurse')
    const admin = await login('admin')
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 100 })
    try {
      // Compatibility fixture: older Scenario facts retain their original +08:00 representation.
      database.driver.prepare('UPDATE scenario_epoch_state SET virtual_time=?').run('2026-08-24T23:30:00+08:00')
    } finally { database.close() }
    const admission = inpatientCommandResponseSchema.parse(await (await request(registrar, '/api/his/v1/inpatient/admissions', { input: {
      patientId: patient.id, patientVersion: patient.versionId, expectedEpoch: 'epoch-1', admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 } })).json()).data.admission
    expect((await request(nurse, `/api/his/v1/inpatient/admissions/${admission.id}/receive`, {
      input: { encounterVersion: admission.versionId, bedId: 'bed-general-1' } })).status).toBe(200)
    const advanced = await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { input: {
      expectedVirtualTime: '2026-08-24T23:30:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' } })
    expect(advanceVirtualTimeResponseSchema.parse(await advanced.json()).data.bedChargesCreated).toBe(1)
    expect(inpatientDetailSchema.parse(await (await request(nurse, `/api/his/v1/inpatient/admissions/${admission.id}`)).json()).admission.chargesFen).toBe(5000)
  })

  it('岗位科室病区绑定、审计与旧Epoch Grant隔离覆盖住院入口', async () => {
    const { request, runtime, login, registrar, patient } = await setup()
    const nurse = await login('ward-nurse')
    const admin = await login('admin')
    const admission = inpatientCommandResponseSchema.parse(await (await request(registrar, '/api/his/v1/inpatient/admissions', { input: {
      patientId: patient.id, patientVersion: patient.versionId, expectedEpoch: 'epoch-1', admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100 } })).json()).data.admission
    expect((await request(nurse, '/api/auth/role', { practitionerRoleId: 'practitioner-role-ward-nurse-surgery' })).status).toBe(200)
    expect((await request(nurse, `/api/his/v1/inpatient/admissions/${admission.id}`)).status).toBe(403)
    expect(inpatientListSchema.parse(await (await request(nurse, '/api/his/v1/inpatient/admissions')).json()).items).toEqual([])
    const audit = await request(admin, '/fhir/R5/AuditEvent?_count=100')
    expect(audit.status).toBe(200)
    const events = fhirBundleSchema.parse(await audit.json()).entry?.map(entry => entry.resource) ?? []
    expect(JSON.stringify(events)).toContain('inpatient.admission.register')
    expect(JSON.stringify(events)).toContain('actor-registrar')
    const client = agentClientSchema.parse(await (await request(admin, '/api/agent/v1/clients', { name: '合成住院测试Agent' })).json())
    const grant = agentCapabilityGrantSchema.parse(await (await request(admin, '/api/agent/v1/grants', {
      agentClientId: client.agentClientId, operationIds: ['inpatient.admission.list'], practitionerRoleId: 'practitioner-role-ward-nurse', ttlSeconds: 3600 })).json())
    const agentList = () => runtime.app.request('/api/his/v1/inpatient/admissions', { headers: { authorization: `Bearer ${grant.token}` } })
    expect((await agentList()).status).toBe(200)
    expect((await runtime.app.request('/api/his/v1/inpatient/admissions', { method: 'POST',
      headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ input: { patientId: patient.id, patientVersion: patient.versionId, expectedEpoch: 'epoch-1', admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 } }),
    })).status).toBe(403)
    expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', {})).status).toBe(200)
    expect((await agentList()).status).toBe(401)
    expect(inpatientListSchema.parse(await (await request(registrar, '/api/his/v1/inpatient/admissions')).json()).items).toEqual([])
    expect((await request(registrar, `/api/his/v1/inpatient/admissions/${admission.id}`)).status).toBe(404)
  })

  it('已重置旧库重启保留活动Epoch患者，并在当前Epoch补齐新岗位和病区环境', async () => {
    const { request, runtime, login, registrar, databasePath, reopen } = await setup()
    const admin = await login('admin')
    expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', {})).status).toBe(200)
    const created = await request(registrar, '/api/his/v1/patients', { expectedVersions: {}, input: {
      name: '合成升级保留患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } })
    expect(created.status).toBe(200)
    const patientId = (await created.json()).data.patient.id
    const current = await (await request(admin, '/api/sim/v1/scenario-runs/current')).json()
    await runtime.close()
    const database = openClinMeshDatabase({ databasePath, busyTimeoutMs: 100 })
    try {
      database.driver.exec('BEGIN IMMEDIATE')
      database.driver.prepare('DELETE FROM inpatient_bed WHERE epoch=?').run(current.epoch)
      database.driver.prepare('DELETE FROM inpatient_ward WHERE epoch=?').run(current.epoch)
      for (const table of ['fhir_sp_string', 'fhir_history', 'fhir_resource']) {
        database.driver.prepare(`DELETE FROM ${table} WHERE epoch=? AND (resource_id LIKE 'ward-%' OR resource_id LIKE 'room-%' OR resource_id LIKE 'bed-%'
          OR resource_id LIKE 'organization-inpatient-%' OR resource_id LIKE '%inpatient-doctor%' OR resource_id LIKE '%ward-nurse%' OR resource_id LIKE '%medical-records%')`).run(current.epoch)
      }
      database.driver.exec('COMMIT')
    } finally { database.close() }
    const reopened = await reopen()
    const get = (path: string) => reopened.app.request(path, { headers: { cookie: admin } })
    expect((await (await get('/api/sim/v1/scenario-runs/current')).json()).epoch).toBe(current.epoch)
    expect((await get(`/fhir/R5/Patient/${patientId}`)).status).toBe(200)
    for (const id of ['practitioner-role-inpatient-doctor', 'practitioner-role-inpatient-doctor-surgery', 'practitioner-role-ward-nurse', 'practitioner-role-medical-records']) {
      expect((await get(`/fhir/R5/PractitionerRole/${id}`)).status).toBe(200)
    }
    const catalog = await reopened.app.request('/api/his/v1/inpatient/catalog', { headers: { cookie: registrar } })
    expect((await catalog.json()).wards).toHaveLength(2)
  })

  it('人类Cookie延迟提交旧Epoch登记即使Patient标识和版本重用也不能在新Epoch收款', async () => {
    const { request, runtime, login, registrar } = await setup()
    const admin = await login('admin')
    const install = async () => {
      const response = await request(admin, '/api/sim/v1/scenarios/actions/install', { kind: 'density' })
      expect(response.status).toBe(200)
      return (await response.json()).data
    }
    const before = await install()
    const patient = await (await request(registrar, '/fhir/R5/Patient/density-patient-001')).json()
    const frozen = { input: { expectedEpoch: before.epoch, patientId: patient.id, patientVersion: patient.meta.versionId,
      admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 } }
    const key = randomUUID()
    const after = await install()
    const repeated = await (await request(registrar, '/fhir/R5/Patient/density-patient-001')).json()
    expect(repeated.meta.versionId).toBe(patient.meta.versionId)
    expect(after.epoch).not.toBe(before.epoch)
    const response = await request(registrar, '/api/his/v1/inpatient/admissions', frozen, key)
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('INPATIENT_EPOCH_CONFLICT')
    expect(inpatientListSchema.parse(await (await request(registrar, '/api/his/v1/inpatient/admissions')).json()).items).toEqual([])
    expect(runtime.database.driver.prepare('SELECT COUNT(*) count FROM inpatient_deposit WHERE workspace_id=? AND epoch=?')
      .get('workspace-demo', after.epoch)).toEqual({ count: 0 })
  })
})
