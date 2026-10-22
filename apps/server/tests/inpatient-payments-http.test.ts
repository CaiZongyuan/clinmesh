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
  it('预交金未知跨重启保留，查询原尝试后唯一入账；未查明前不能重收或封账', async () => {
    const s = await setup()
    const input = { kind: 'deposit', amountFen: 2000, tenders: [{ method: 'cash', amountFen: 2000 }], simulatorRule: 'ambiguous' }
    const reviewed = (await (await s.request(s.cashier, `${s.path}/payments/preview`, input)).json()).data
    const first = await s.request(s.cashier, `${s.path}/payments/confirm`, { previewId: reviewed.previewId, commitToken: reviewed.commitToken })
    expect(first.status).toBe(200)
    const attempt = (await first.json()).data
    expect(attempt.outcome).toBe('ambiguous')
    expect((await s.request(s.cashier, `${s.path}/payments/preview`, input)).status).toBe(409)
    const received = (await (await s.request(s.nurse, `${s.path}/receive`, { encounterVersion: s.admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
    const issued = (await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: received.versionId, reason: '合成临床出院' })).json()).data.admission
    expect((await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issued.versionId, reason: '合成出区', departureMethod: 'home' })).status).toBe(200)
    const preview = (await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json())
    const blocked = await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: 0, expectedBalanceFen: -1000 })
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).error.code).toBe('INPATIENT_FUNDS_PENDING')
    await s.restart()
    const key = randomUUID(), recovery = { paymentId: attempt.paymentId, expectedPaymentVersion: 1 }
    const recovered = await s.request(s.cashier, `${s.path}/payments/recover`, recovery, key)
    expect(recovered.status).toBe(200)
    expect((await recovered.clone().json()).data).toMatchObject({ outcome: 'success', version: 2 })
    expect(await (await s.request(s.cashier, `${s.path}/payments/recover`, recovery, key)).json()).toEqual(await recovered.json())
    expect((await (await s.request(s.cashier, s.path)).json()).admission.depositFen).toBe(3000)
  })
  it('首次退款未知阻止封账和清床，查询原退款后保留冻结账且不重复退', async () => {
    const s = await setup()
    const received = (await (await s.request(s.nurse, `${s.path}/receive`, { encounterVersion: s.admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
    const issued = (await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: received.versionId, reason: '合成出院' })).json()).data.admission
    await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issued.versionId, reason: '合成出区', departureMethod: 'home' })
    const statement = await (await s.request(s.cashier, `${s.path}/payments`)).json()
    const reviewedResponse = await s.request(s.cashier, `${s.path}/refunds/preview`, { sourceId: statement.sources[0].id, amountFen: 1000, simulatorRule: 'ambiguous' })
    expect(reviewedResponse.status).toBe(200)
    const reviewed = (await reviewedResponse.json()).data
    const refund = (await (await s.request(s.cashier, `${s.path}/refunds/confirm`, { previewId: reviewed.previewId, commitToken: reviewed.commitToken })).json()).data
    expect(refund.outcome).toBe('ambiguous')
    const preview = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    const settle = { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: 0, expectedBalanceFen: -1000 }
    expect((await s.request(s.cashier, `${s.path}/discharge/settle`, settle)).status).toBe(409)
    expect((await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: preview.encounterVersion, reason: '不得清床' })).status).toBe(409)
    expect((await s.request(s.cashier, `${s.path}/refunds/preview`, { sourceId: statement.sources[0].id, amountFen: 1, simulatorRule: 'success' })).status).toBe(409)
    const recovery = { refundId: refund.refundId, expectedRefundVersion: 1 }, key = randomUUID()
    const recovered = await s.request(s.cashier, `${s.path}/refunds/recover`, recovery, key)
    expect(recovered.status).toBe(200)
    expect((await recovered.clone().json()).data).toMatchObject({ refundId: refund.refundId, outcome: 'success', version: 2 })
    expect(await (await s.request(s.cashier, `${s.path}/refunds/recover`, recovery, key)).json()).toEqual(await recovered.json())
    expect((await s.request(s.cashier, `${s.path}/discharge/settle`, settle)).status).toBe(409)
    const fresh = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    const frozen = await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: fresh.encounterVersion, fingerprint: fresh.fingerprint, expectedChargesFen: 0, expectedBalanceFen: -1000 })
    expect(frozen.status).toBe(200)
    const result = (await frozen.json()).data
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions.find((item: {kind:string}) => item.kind === 'refund')).toMatchObject({ id: refund.refundId, sourceDepositId: statement.sources[0].id, amountFen: -1000 })
    expect((await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: result.encounterVersion, reason: '资金确定后清床' })).status).toBe(200)
  })
})
