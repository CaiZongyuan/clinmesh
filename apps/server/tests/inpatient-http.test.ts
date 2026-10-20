import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { inpatientCommandResponseSchema, inpatientListSchema, advanceVirtualTimeResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'

describe('住院建档与入科 HTTP 合同', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const directories: string[] = []
  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-'))
    directories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({ authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
      migrationMode: 'apply', trustedOrigins: ['http://localhost'] })
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
    return { runtime, login, request, registrar, patient }
  }
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })))
  })

  it('登记员直接入院形成独立住院号，预交金重试只收取一次，管理员不能代办', async () => {
    const { request, login, registrar, patient } = await setup()
    const input = { input: { patientId: patient.id, patientVersion: patient.versionId,
      admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100_000 } }
    const key = randomUUID()
    const first = await request(registrar, '/api/his/v1/inpatient/admissions', input, key)
    expect(first.status).toBe(200)
    const admission = inpatientCommandResponseSchema.parse(await first.json()).data.admission
    expect(admission).toMatchObject({ patientId: patient.id, status: 'registered', depositFen: 100_000,
      chargesFen: 0, wardId: 'ward-general', financialStatus: 'open', recordStatus: 'open' })
    const replay = await request(registrar, '/api/his/v1/inpatient/admissions', input, key)
    expect(replay.status).toBe(200)
    expect((await replay.json()).data.admission).toEqual(admission)
    const second = await request(registrar, '/api/his/v1/inpatient/admissions', input)
    expect(second.status).toBe(200)
    expect((await second.json()).data.admission.inpatientNumber).not.toBe(admission.inpatientNumber)
    const list = await request(registrar, '/api/his/v1/inpatient/admissions')
    expect(inpatientListSchema.parse(await list.json()).items).toHaveLength(2)
    expect((await request(await login('admin'), '/api/his/v1/inpatient/admissions', input)).status).toBe(403)
  })

  it('病区接诊分床拒绝重复占用，转床与换床原子完成，错误版本或跨病区均保持原床', async () => {
    const { request, login, registrar, patient } = await setup()
    const nurse = await login('ward-nurse')
    async function register() {
      const response = await request(registrar, '/api/his/v1/inpatient/admissions', { input: {
        patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct',
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
      patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 } })
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
    expect(advanceVirtualTimeResponseSchema.parse(await response.json()).data.bedChargesCreated).toBe(1)
    expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', advance, key)).status).toBe(200)
    const detail = inpatientDetailSchema.parse(await (await request(nurse, `/api/his/v1/inpatient/admissions/${a.id}`)).json())
    expect(detail.admission.chargesFen).toBe(5000)
    const unchanged = await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { input: { expectedVirtualTime: next, targetVirtualTime: next } })
    expect(advanceVirtualTimeResponseSchema.parse(await unchanged.json()).data.bedChargesCreated).toBe(0)
    expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', advance)).status).toBe(409)
  })
})
