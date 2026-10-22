import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-payments-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const options = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'] }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key: string = randomUUID()) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': key }, ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  }
  const registrar = await login('registrar'), cashier = await login('cashier'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成共享支付患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  expect(created.status).toBe(200)
  const patient = (await created.json()).data.patient
  const registered = await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 1000 })
  expect(registered.status).toBe(200)
  const admission = (await registered.json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  return { admission, path, request, login, cashier, doctor, nurse, registrar, runtime: () => runtime,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

describe('住院共享资金公共 HTTP', () => {
  it('收费员按已审阅预览收取组合预交金，刷新及原key重放不重复记账', async () => {
    const s = await setup()
    const input = { kind: 'deposit', amountFen: 2500, tenders: [{ method: 'cash', amountFen: 1000 }, { method: 'mobile', amountFen: 1500 }], simulatorRule: 'success' }
    const preview = await s.request(s.cashier, `${s.path}/payments/preview`, input)
    expect(preview.status).toBe(200)
    const reviewed = (await preview.json()).data
    expect(reviewed).toMatchObject({ amountFen: 2500, expectedOutcome: 'success', tenders: input.tenders })
    const key = randomUUID(), confirmation = { previewId: reviewed.previewId, commitToken: reviewed.commitToken }
    const confirmed = await s.request(s.cashier, `${s.path}/payments/confirm`, confirmation, key)
    expect(confirmed.status).toBe(200)
    const result = await confirmed.json()
    expect(result.data).toMatchObject({ amountFen: 2500, outcome: 'success', kind: 'deposit' })
    expect(await (await s.request(s.cashier, `${s.path}/payments/confirm`, confirmation, key)).json()).toEqual(result)
    expect((await (await s.request(s.cashier, s.path)).json()).admission.depositFen).toBe(3500)
    const statement = await (await s.request(s.cashier, `${s.path}/payments`)).json()
    expect(statement.payments).toHaveLength(1)
    expect(statement.payments[0].tenders).toEqual(input.tenders)
  })
})
