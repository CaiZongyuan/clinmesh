import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-financial-adjustment-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
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
  const registrar = await login('registrar'), cashier = await login('cashier'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), admin = await login('admin')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成归档财务患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  const patient = (await created.json()).data.patient
  const registered = (await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 10000 })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  const received = await request(nurse, `${path}/receive`, { encounterVersion: registered.versionId, bedId: 'bed-general-1' })
  expect(received.status).toBe(200)
  expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })).status).toBe(200)
  const issued = await request(doctor, `${path}/discharge/issue`, { encounterVersion: (await received.json()).data.admission.versionId, reason: '合成治疗完成' })
  const departed = await request(nurse, `${path}/discharge/depart`, { encounterVersion: (await issued.json()).data.admission.versionId, reason: '完成出区核对', departureMethod: 'home' })
  expect(departed.status).toBe(200)
  const preview = await (await request(cashier, `${path}/discharge/preview`)).json()
  const settlement = await request(cashier, `${path}/discharge/settle`, { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint,
    expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })
  expect(settlement.status).toBe(200)
  const settled = (await settlement.json()).data
  expect((await request(nurse, `${path}/discharge/clear`, { encounterVersion: settled.encounterVersion, reason: '完成床单位清洁' })).status).toBe(200)
  return { path, request, login, cashier, doctor, nurse, registrar, admin, settled, runtime: () => runtime,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

describe('首次结算后的财务更正公共 HTTP', () => {
  it('后续未知退款只挂起调整，重启查询原尝试后结清差额且不改变首次冻结资金', async () => {
    const s = await setup()
    const before = await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json()
    const adjusted = await s.request(s.cashier, `${s.path}/financial-adjustments`, { chargeId: before.charges[0].chargeId,
      amountFen: 2000, expectedFingerprint: before.fingerprint, reason: '合成后续床日费冲减' })
    expect(adjusted.status).toBe(200)
    const bill = (await adjusted.json()).data, source = bill.sources[0]
    const preview = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, {
      adjustmentId: bill.adjustments[0].adjustmentId, sourceKind: source.sourceKind, sourceId: source.sourceId,
      amountFen: 2000, expectedFingerprint: bill.fingerprint, expectedSourceVersion: source.version, simulatorRule: 'ambiguous' })
    expect(preview.status).toBe(200)
    const reviewed = (await preview.json()).data
    const confirmation = { previewId: reviewed.previewId, commitToken: reviewed.commitToken }, key = randomUUID()
    const response = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, confirmation, key)
    expect(response.status).toBe(200)
    const receipt = await response.json()
    expect(receipt.data).toMatchObject({ outcome: 'ambiguous', amountFen: 2000 })
    const pending = await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json()
    expect(pending).toMatchObject({ currentFundsFen: 5000, currentChargesFen: 3000, reservedFen: 2000 })
    expect(pending.adjustments[0].status).toBe('unknown')
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, {
      adjustmentId: bill.adjustments[0].adjustmentId, sourceKind: source.sourceKind, sourceId: source.sourceId,
      amountFen: 1, expectedFingerprint: pending.fingerprint, expectedSourceVersion: pending.sources[0].version, simulatorRule: 'success' })).status).toBe(409)
    await s.restart()
    expect(await (await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, confirmation, key)).json()).toEqual(receipt)
    const recovery = { refundId: receipt.data.refundId, expectedRefundVersion: 1 }, recoveryKey = randomUUID()
    const recovered = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/recover`, recovery, recoveryKey)
    expect(recovered.status).toBe(200)
    expect((await recovered.json()).data).toMatchObject({ outcome: 'success', version: 2 })
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/recover`, recovery, recoveryKey)).status).toBe(200)
    const current = await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json()
    expect(current).toMatchObject({ currentFundsFen: 3000, currentChargesFen: 3000, remainingRefundFen: 0, reservedFen: 0 })
    expect(current.refunds).toHaveLength(1)
    expect(current.adjustments[0].status).toBe('completed')
    const frozen = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    expect(frozen.transactions).toEqual(s.settled.transactions)
    expect(frozen.settlement).toEqual(s.settled.settlement)
    expect((await (await s.request(s.cashier, s.path)).json()).admission).toMatchObject({ status: 'cleared', financialStatus: 'settled' })
  })
  it('追加原费用冲减保留首次结算与清床事实，旧key不重复更正且其他岗位拒绝', async () => {
    const s = await setup()
    const beforeResponse = await s.request(s.cashier, `${s.path}/financial-adjustments`)
    expect(beforeResponse.status).toBe(200)
    const before = await beforeResponse.json()
    expect(before).toMatchObject({ frozenChargesFen: 5000, currentChargesFen: 5000, currentFundsFen: 5000, remainingRefundFen: 0 })
    const input = { chargeId: before.charges[0].chargeId, amountFen: 2000, expectedFingerprint: before.fingerprint, reason: '合成床日费金额核对更正' }
    for (const cookie of [s.doctor, s.nurse, s.registrar, s.admin, await s.login('medical-records')]) {
      expect((await s.request(cookie, `${s.path}/financial-adjustments`, input)).status).toBe(403)
    }
    const key = randomUUID(), response = await s.request(s.cashier, `${s.path}/financial-adjustments`, input, key)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.data).toMatchObject({ frozenChargesFen: 5000, currentChargesFen: 3000, currentFundsFen: 5000, remainingRefundFen: 2000 })
    expect(result.data.adjustments).toHaveLength(1)
    expect(await (await s.request(s.cashier, `${s.path}/financial-adjustments`, input, key)).json()).toEqual(result)
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments`, input)).status).toBe(409)
    const after = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    expect(after.charges).toEqual(s.settled.charges)
    expect(after.transactions).toEqual(s.settled.transactions)
    expect(after.settlement).toEqual(s.settled.settlement)
    expect((await (await s.request(s.cashier, s.path)).json()).admission).toMatchObject({ status: 'cleared', financialStatus: 'settled', recordStatus: 'open' })
    await s.restart()
    expect((await (await s.request(s.cashier, `${s.path}/financial-adjustments`)).json()).adjustments).toHaveLength(1)
  })
})
