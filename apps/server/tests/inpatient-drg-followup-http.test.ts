import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-followup-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const password = `Test-${randomUUID()}-Aa1!`
  const options = { authBaseUrl: 'http://localhost', trustedOrigins: ['http://localhost'], demoPassword: password,
    authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'hospital.sqlite'), migrationMode: 'apply' as const }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(() => runtime.close())
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key = randomUUID()) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  }
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: {
    cookie: registrar, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
  body: JSON.stringify({ expectedVersions: {}, input: { name: '合成跟进患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  expect(created.status).toBe(200)
  const patient = (await created.json()).data.patient
  const registered = await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 })
  expect(registered.status).toBe(200)
  const admission = (await registered.json()).data.admission, path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const received = await request(nurse, `${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })
  expect(received.status).toBe(200)
  const current = (await received.json()).data.admission
  return { request, doctor, nurse, registrar, admission: current, path,
    runtime: () => runtime, restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

describe('住院 DRG 后台规则跟进公开 HTTP', () => {
  it('重复开启、原意图恢复及重启保持唯一任务；缺规则如实显示，停止后不再分析', async () => {
    const s = await setup(), input = { encounterVersion: s.admission.versionId, expectedTaskVersion: 0 }, key = randomUUID()
    const response = await s.request(s.doctor, `${s.path}/drg/followup/start`, input, key)
    expect(response.status).toBe(200)
    const receipt = await response.json(), task = receipt.data.task
    expect(task).toMatchObject({ admissionId: s.admission.id, status: 'active' })
    expect(await (await s.request(s.doctor, `${s.path}/drg/followup/start`, input, key)).json()).toEqual(receipt)
    const repeated = await s.request(s.doctor, `${s.path}/drg/followup/start`, input)
    expect(repeated.status).toBe(200)
    expect((await repeated.json()).data.task.id).toBe(task.id)
    await s.runtime().dispatchPending()
    const result = await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()
    expect(result.task).toMatchObject({ id: task.id, status: 'active', ruleStatus: 'incomplete', errorCode: 'DRG_RULES_NOT_CONFIGURED', modelRequests: 0 })
    expect(result.task.simulation).toBeNull()
    await s.restart()
    await s.runtime().dispatchPending()
    const restored = await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()
    expect(restored.task.id).toBe(task.id)
    const stopped = await s.request(s.doctor, `${s.path}/drg/followup/stop`, {
      encounterVersion: restored.encounterVersion, expectedTaskVersion: restored.task.version, reason: '医生结束本轮跟进' })
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).data.task.status).toBe('stopped')
    await s.restart()
    await s.runtime().dispatchPending()
    expect((await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()).task.status).toBe('stopped')
  })
})
