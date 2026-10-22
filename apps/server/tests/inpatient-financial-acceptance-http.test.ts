import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inpatientFinancialSchema, inpatientFinancialResponseSchema, inpatientFinancialRefundPreviewResponseSchema } from '@clinmesh/contracts/inpatient-finance'
import { inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientRecordSchema, inpatientRecordResponseSchema } from '@clinmesh/contracts/inpatient-record'
import { refundResponseSchema } from '@clinmesh/contracts/refunds'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-financial-acceptance-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
    system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成正式目录高血压', status: 'active',
    sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457' }], medicationProducts: syntheticNhsaMedicationProductSnapshot,
    services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
  await writeFile(join(directory, 'reference.json'), artifact)
  await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-financial-acceptance', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z',
    sources: [{ sourceId: 'synthetic-financial-acceptance', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'),
      licenseId: 'CC0-1.0', retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), referenceDatabasePath,
    activeReferenceReleaseId: 'synthetic-financial-acceptance', demoPassword: password, migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
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
  const registrar = await login('registrar'), cashier = await login('cashier'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), coder = await login('medical-records'), admin = await login('admin')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成财务验收患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  expect(created.status).toBe(200)
  const patient = (await created.json()).data.patient
  const registeredResponse = await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 5000 })
  expect(registeredResponse.status).toBe(200)
  const registered = (await registeredResponse.json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  const received = await request(nurse, `${path}/receive`, { encounterVersion: registered.versionId, bedId: 'bed-general-1' })
  expect(received.status).toBe(200)
  expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })).status).toBe(200)
  const issued = await request(doctor, `${path}/discharge/issue`, { encounterVersion: (await received.json()).data.admission.versionId, reason: '合成临床治疗完成' })
  expect(issued.status).toBe(200)
  expect((await request(nurse, `${path}/discharge/depart`, { encounterVersion: (await issued.json()).data.admission.versionId, reason: '合成出区核对完成', departureMethod: 'home' })).status).toBe(200)
  const preview = inpatientSettlementPreviewSchema.parse(await (await request(cashier, `${path}/discharge/preview`)).json())
  const settled = await request(cashier, `${path}/discharge/settle`, { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint,
    expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })
  expect(settled.status).toBe(200)
  const settlement = inpatientSettlementResponseSchema.parse(await settled.json()).data
  expect((await request(nurse, `${path}/discharge/clear`, { encounterVersion: settlement.encounterVersion, reason: '完成床单位清洁' })).status).toBe(200)
  const read = async () => inpatientFinancialSchema.parse(await (await request(cashier, `${path}/financial-adjustments`)).json())
  return { path, request, login, read, cashier, doctor, nurse, coder, registrar, admin, password, runtime: () => runtime,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

type Setup = Awaited<ReturnType<typeof setup>>
async function adjust(s: Setup, direction: 'increase' | 'decrease', amountFen: number) {
  const before = await s.read()
  const response = await s.request(s.cashier, `${s.path}/financial-adjustments`, { chargeId: before.charges[0]!.chargeId, direction, amountFen,
    expectedFingerprint: before.fingerprint, reason: direction === 'increase' ? '合成原费用漏计补正' : '合成原费用金额冲减' })
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
  return inpatientFinancialResponseSchema.parse(await response.json()).data
}
async function refund(s: Setup, amountFen: number, sourceKind?: 'inpatient-supplement') {
  const bill = await s.read(), adjustment = bill.adjustments.find(item => item.direction === 'decrease' && item.remainingFen >= amountFen)!
  const source = bill.sources.find(item => item.refundableFen >= amountFen && (sourceKind === undefined || item.sourceKind === sourceKind))!
  expect(source).toBeDefined()
  const response = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, { adjustmentId: adjustment.adjustmentId,
    sourceKind: source.sourceKind, sourceId: source.sourceId, amountFen, expectedFingerprint: bill.fingerprint, expectedSourceVersion: source.version, simulatorRule: 'success' })
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
  const preview = inpatientFinancialRefundPreviewResponseSchema.parse(await response.json()).data
  const confirmed = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, { previewId: preview.previewId, commitToken: preview.commitToken })
  expect(confirmed.status, JSON.stringify(await confirmed.clone().json())).toBe(200)
  return refundResponseSchema.parse(await confirmed.json()).data
}
async function archive(s: Setup) {
  const clinical = await (await s.request(s.doctor, `${s.path}/clinical`)).json()
  const diagnosis = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
    entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '合成正式病案诊断依据' }] })
  expect(diagnosis.status).toBe(200)
  const record = inpatientRecordSchema.parse(await (await s.request(s.doctor, `${s.path}/record`)).json())
  const expected = { expectedRevision: 1, expectedSourcesHash: record.sourcesHash }
  expect((await s.request(s.doctor, `${s.path}/record/submit`, { ...expected, expectedRevision: 0, mainProcedureExecutionId: null })).status).toBe(200)
  expect((await s.request(s.coder, `${s.path}/record/review`, { ...expected, outcome: 'approved' })).status).toBe(200)
  const response = await s.request(s.coder, `${s.path}/record/archive`, expected)
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
  return inpatientRecordResponseSchema.parse(await response.json()).data
}

describe('结算后独立财务验收公共 HTTP', () => {
  it('真实病案归档前后办理冲减退款与补收，原首页、首次结算和清床事实保持不变', async () => {
    const s = await setup()
    const settlement = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    const events = await (await s.request(s.nurse, `${s.path}/discharge`)).json()
    const charges = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    await adjust(s, 'decrease', 1000)
    expect(await refund(s, 1000)).toMatchObject({ outcome: 'success', amountFen: 1000 })
    expect(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()).toEqual(settlement)
    expect(await (await s.request(s.cashier, `${s.path}/charges`)).json()).toEqual(charges)
    const archived = await archive(s)
    expect(archived.archive).toBeDefined()
    expect(archived.archive!.snapshot.fees).toMatchObject({ chargesFen: 5000, depositFen: 5000 })
    // 正式诊断确认会合法升级 Encounter；财务操作分别对照归档前后的当前读取基线。
    const archivedSettlement = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    const archivedCharges = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    const increased = await adjust(s, 'increase', 1500)
    const previewResponse = await s.request(s.cashier, `${s.path}/financial-adjustments/payments/preview`, {
      adjustmentId: increased.adjustments.find(item => item.direction === 'increase')!.adjustmentId, amountFen: 1500, expectedFingerprint: increased.fingerprint,
      tenders: [{ method: 'cash', amountFen: 500 }, { method: 'bank-card', amountFen: 1000 }], simulatorRule: 'success' })
    expect(previewResponse.status).toBe(200)
    const preview = inpatientPaymentPreviewResponseSchema.parse(await previewResponse.json()).data
    const payment = await s.request(s.cashier, `${s.path}/financial-adjustments/payments/confirm`, { previewId: preview.previewId, commitToken: preview.commitToken })
    expect(payment.status).toBe(200)
    expect(inpatientPaymentResponseSchema.parse(await payment.json()).data).toMatchObject({ amountFen: 1500, outcome: 'success' })
    await adjust(s, 'decrease', 500)
    expect(await refund(s, 500, 'inpatient-supplement')).toMatchObject({ sourceKind: 'inpatient-supplement', amountFen: 500, outcome: 'success', tenders: [{ method: 'cash', amountFen: 500 }] })
    expect(await s.read()).toMatchObject({ recordStatus: 'archived', currentChargesFen: 5000, currentFundsFen: 5000, remainingCollectFen: 0, remainingRefundFen: 0 })
    expect(await (await s.request(s.coder, `${s.path}/record`)).json()).toEqual(archived)
    expect(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()).toEqual(archivedSettlement)
    expect(await (await s.request(s.nurse, `${s.path}/discharge`)).json()).toEqual(events)
    expect(await (await s.request(s.cashier, `${s.path}/charges`)).json()).toEqual(archivedCharges)
    await s.restart()
    expect(await (await s.request(s.coder, `${s.path}/record`)).json()).toEqual(archived)
    expect(await s.read()).toMatchObject({ recordStatus: 'archived', currentChargesFen: 5000, currentFundsFen: 5000 })
  })
})
