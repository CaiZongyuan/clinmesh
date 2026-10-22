import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDischargeResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { createClinMeshRuntime } from '../../src/runtime.ts'

export async function inpatientInsuranceFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-insurance-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'),
    demoPassword: password, migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'],
  }
  let runtime = await createClinMeshRuntime(options)
  const cookies = new Map<string, string>()
  async function login(name: string) {
    const existing = cookies.get(name)
    if (existing !== undefined) return existing
    const response = await runtime.app.request('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }),
    })
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0]!
    cookies.set(name, cookie)
    return cookie
  }
  async function request(role: string, path: string, input?: unknown, key = randomUUID()) {
    return runtime.app.request(path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { cookie: await login(role), origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }),
    })
  }
  async function insurance(admissionId: string, action: string, input: unknown, key = randomUUID()) {
    return runtime.app.request(`/api/his/v1/insurance/inpatient/${admissionId}/${action}`, {
      method: 'POST', headers: { cookie: await login('cashier'), origin: 'http://localhost',
        'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ input, expectedVersions: {} }),
    })
  }
  const created = await runtime.app.request('/api/his/v1/patients', {
    method: 'POST', headers: { cookie: await login('registrar'), origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成医保患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
    } }),
  })
  expect(created.status).toBe(200)
  const patient = createPatientResponseSchema.parse(await created.json()).data.patient
  async function admit(depositFen = 0) {
    const response = await request('registrar', '/api/his/v1/inpatient/admissions', {
      expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId,
      admissionRoute: 'direct', wardId: 'ward-general', depositFen,
    })
    expect(response.status).toBe(200)
    const registered = inpatientCommandResponseSchema.parse(await response.json()).data.admission
    const received = await request('ward-nurse', `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
      encounterVersion: registered.versionId, bedId: 'bed-general-1',
    })
    expect(received.status).toBe(200)
    return inpatientCommandResponseSchema.parse(await received.json()).data.admission
  }
  async function depart(admission: Awaited<ReturnType<typeof admit>>) {
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    const issue = await request('inpatient-doctor', `${path}/discharge/issue`, {
      encounterVersion: admission.versionId, reason: '合成治疗完成',
    })
    expect(issue.status).toBe(200)
    const issued = inpatientDischargeResponseSchema.parse(await issue.json()).data.admission
    const departure = await request('ward-nurse', `${path}/discharge/depart`, {
      encounterVersion: issued.versionId, reason: '合成出区核对完成', departureMethod: 'home',
    })
    expect(departure.status).toBe(200)
    return inpatientDischargeResponseSchema.parse(await departure.json()).data.admission
  }
  return { get runtime() { return runtime }, options, patient, request, insurance, login, admit, depart,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) }, close: async () => {
    await runtime.close()
    await rm(directory, { recursive: true })
  } }
}
