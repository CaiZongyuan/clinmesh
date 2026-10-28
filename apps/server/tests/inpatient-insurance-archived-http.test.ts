import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientChargesSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDischargeResponseSchema, inpatientPaymentPreviewResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientFinancialSchema, inpatientFinancialResponseSchema, inpatientFinancialRefundPreviewResponseSchema } from '@clinmesh/contracts/inpatient-finance'
import { inpatientRecordSchema, inpatientRecordResponseSchema } from '@clinmesh/contracts/inpatient-record'
import { insurancePreviewResponseSchema, insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { refundResponseSchema } from '@clinmesh/contracts/refunds'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-insurance-archive-'))
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
    system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成正式目录高血压', status: 'active',
    sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457' }], medicationProducts: syntheticNhsaMedicationProductSnapshot,
    services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
  await writeFile(join(directory, 'reference.json'), artifact)
  await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-insurance-archive', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z',
    sources: [{ sourceId: 'synthetic-insurance-archive', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'),
      licenseId: 'CC0-1.0', retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  const password = `Test-${randomUUID()}-Aa1!`
  const options = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), referenceDatabasePath,
    activeReferenceReleaseId: 'synthetic-insurance-archive', demoPassword: password, migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'] }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  const cookies = new Map<string, string>()
  async function login(role: string) {
    const existing = cookies.get(role)
    if (existing !== undefined) return existing
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${role}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0]!
    cookies.set(role, cookie)
    return cookie
  }
  async function request(role: string, path: string, input?: unknown, key = randomUUID()) {
    const envelope = path === '/api/his/v1/patients' || path.startsWith('/api/his/v1/insurance/') ? { input, expectedVersions: {} } : { input }
    const response = await runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie: await login(role), origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': key }, ...(input === undefined ? {} : { body: JSON.stringify(envelope) }) })
    expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200)
    return response
  }
  const created = await request('registrar', '/api/his/v1/patients', { name: '合成归档医保患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` })
  const patient = createPatientResponseSchema.parse(await created.json()).data.patient
  const registered = inpatientCommandResponseSchema.parse(await (await request('registrar', '/api/his/v1/inpatient/admissions', {
    expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 5000,
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  const received = inpatientCommandResponseSchema.parse(await (await request('ward-nurse', `${path}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1',
  })).json()).data.admission
  await request('admin', '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
    expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-27T00:00:00+08:00',
  })
  const issued = inpatientDischargeResponseSchema.parse(await (await request('inpatient-doctor', `${path}/discharge/issue`, {
    encounterVersion: received.versionId, reason: '合成临床治疗完成',
  })).json()).data.admission
  await request('ward-nurse', `${path}/discharge/depart`, { encounterVersion: issued.versionId, reason: '合成出区核对完成', departureMethod: 'home' })
  const insurancePath = `/api/his/v1/insurance/inpatient/${registered.id}`
  const preview = insurancePreviewResponseSchema.parse(await (await request('cashier', `${insurancePath}/preview`, { planCode: 'employee-v1' })).json()).data
  const original = insuranceResponseSchema.parse(await (await request('cashier', `${insurancePath}/confirm`, {
    previewId: preview.previewId, commitToken: preview.commitToken,
  })).json()).data.active!
  expect(original).toMatchObject({ totalFen: 15000, fundFen: 8000, accountFen: 2000, patientFen: 5000 })
  const first = inpatientSettlementPreviewSchema.parse(await (await request('cashier', `${path}/discharge/preview`)).json())
  const settled = inpatientSettlementResponseSchema.parse(await (await request('cashier', `${path}/discharge/settle`, {
    encounterVersion: first.encounterVersion, fingerprint: first.fingerprint, expectedChargesFen: first.chargesFen, expectedBalanceFen: first.balanceFen,
  })).json()).data
  await request('ward-nurse', `${path}/discharge/clear`, { encounterVersion: settled.encounterVersion, reason: '合成床单位清洁完成' })
  const clinical = inpatientFullClinicalSchema.parse(await (await request('inpatient-doctor', `${path}/clinical`)).json())
  await request('inpatient-doctor', `${path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
    entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '合成正式归档诊断依据' }] })
  const record = inpatientRecordSchema.parse(await (await request('inpatient-doctor', `${path}/record`)).json())
  expect(record.snapshot.clinical).toMatchObject({ diagnosis: { revision: 1, entries: [{ role: 'primary', admissionCondition: '1', coding: { code: 'I10.x09' } }] },
    operations: [], mainProcedureExecutionId: null })
  expect(record.snapshot.fees).toMatchObject({ chargesFen: 15000, depositFen: 5000, insurance: original })
  expect(record.snapshot.fees.transactions.reduce((sum, transaction) => sum + transaction.amountFen, 0)).toBe(5000)
  const expected = { expectedRevision: 1, expectedSourcesHash: record.sourcesHash }
  await request('inpatient-doctor', `${path}/record/submit`, { ...expected, expectedRevision: 0, mainProcedureExecutionId: null })
  await request('medical-records', `${path}/record/review`, { ...expected, outcome: 'approved' })
  const archived = inpatientRecordResponseSchema.parse(await (await request('medical-records', `${path}/record/archive`, expected)).json()).data
  expect(archived.archive?.snapshot).toEqual(record.snapshot)
  const read = async () => inpatientFinancialSchema.parse(await (await request('cashier', `${path}/financial-adjustments`)).json())
  const summary = async () => inpatientDetailSchema.parse(await (await request('inpatient-doctor', path)).json()).admission
  const frozen = async () => {
    // Current funding can change after archive; all original admission facts remain frozen.
    const { outstandingFen: _outstandingFen, ...admission } = await summary()
    return {
    recordJson: await (await request('medical-records', `${path}/record`)).text(),
    fees: inpatientSettlementPreviewSchema.parse(await (await request('cashier', `${path}/discharge/preview`)).json()),
    charges: inpatientChargesSchema.parse(await (await request('cashier', `${path}/charges`)).json()),
    admission,
    clinical: inpatientFullClinicalSchema.parse(await (await request('inpatient-doctor', `${path}/clinical`)).json()),
    events: await (await request('ward-nurse', `${path}/discharge`)).json(),
    }
  }
  return { path, request, read, summary, frozen, archived, original, restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

describe('归档后医保更正独立公共 HTTP 验收', () => {
  it('真实归档后冲减、补偿和重结算，未知退款重启恢复保持原首页JSON、费用、医保与临床事实', async () => {
    const s = await setup(), frozen = await s.frozen(), before = await s.read()
    expect(await s.summary()).toHaveProperty('outstandingFen', 0)
    expect(frozen.admission).toMatchObject({ status: 'cleared', financialStatus: 'settled', recordStatus: 'archived' })
    expect(before).toMatchObject({ frozenChargesFen: 15000, frozenFundsFen: 5000, currentChargesFen: 15000, currentFundsFen: 5000, recordStatus: 'archived' })
    const adjusted = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments`, {
      chargeId: before.charges[0]!.chargeId, direction: 'decrease', amountFen: 1000, expectedFingerprint: before.fingerprint, reason: '合成归档后床日费用核对冲减',
    })).json()).data
    const adjustmentId = adjusted.adjustments[0]!.adjustmentId, insurancePath = `${s.path}/financial-adjustments/${adjustmentId}/insurance`
    const cancelled = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${insurancePath}/cancel`, {
      settlementId: s.original.id, expectedBalanceVersion: adjusted.insurance!.balance.version, expectedFingerprint: adjusted.fingerprint,
    })).json()).data
    expect(cancelled.insurance).toMatchObject({ original: s.original, ready: false })
    expect(cancelled.insurance?.active).toBeUndefined()
    expect(await s.summary()).toHaveProperty('outstandingFen', null)
    const preview = insurancePreviewResponseSchema.parse(await (await s.request('cashier', `${insurancePath}/preview`, { expectedFingerprint: cancelled.fingerprint })).json()).data
    expect(preview.settlement).toMatchObject({ year: '2026', planCode: 'employee-v1', totalFen: 14000, fundFen: 7200, accountFen: 2000, patientFen: 4800 })
    const replacement = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${insurancePath}/confirm`, {
      previewId: preview.previewId, commitToken: preview.commitToken,
    })).json()).data
    expect(replacement).toMatchObject({ currentChargesFen: 14000, currentFundsFen: 5000, remainingRefundFen: 200, remainingCollectFen: 0,
      insurance: { original: s.original, active: preview.settlement, ready: true } })
    expect(replacement.insurance?.active?.id).not.toBe(s.original.id)
    expect(replacement.insurance?.cycles).toMatchObject([{ adjustmentId, originalSettlementId: s.original.id, replacementSettlementId: preview.settlement.id }])
    expect(await s.frozen()).toEqual(frozen)
    const source = replacement.sources[0]!
    const money = inpatientFinancialRefundPreviewResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/preview`, {
      adjustmentId, sourceKind: source.sourceKind, sourceId: source.sourceId, amountFen: 200, expectedFingerprint: replacement.fingerprint,
      expectedSourceVersion: source.version, simulatorRule: 'ambiguous',
    })).json()).data
    const input = { previewId: money.previewId, commitToken: money.commitToken }, key = randomUUID()
    const receipt = refundResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/confirm`, input, key)).json())
    expect(receipt.data).toMatchObject({ outcome: 'ambiguous', amountFen: 200, version: 1 })
    const pending = await s.read()
    expect(pending).toMatchObject({ currentFundsFen: 5000, reservedFen: 200, recordStatus: 'archived' })
    expect(pending.adjustments[0]!.status).toBe('unknown')
    expect(await s.summary()).toHaveProperty('outstandingFen', null)
    expect(await s.frozen()).toEqual(frozen)
    await s.restart()
    expect(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/confirm`, input, key)).json()).toEqual(receipt)
    expect(await s.read()).toEqual(pending)
    expect(await s.frozen()).toEqual(frozen)
    const recovery = { refundId: receipt.data.refundId, expectedRefundVersion: 1 }, recoveryKey = randomUUID()
    const resolved = refundResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/recover`, recovery, recoveryKey)).json())
    expect(resolved.data).toMatchObject({ refundId: receipt.data.refundId, outcome: 'success', amountFen: 200, version: 2 })
    expect(await (await s.request('cashier', `${s.path}/financial-adjustments/refunds/recover`, recovery, recoveryKey)).json()).toEqual(resolved)
    const final = await s.read()
    expect(final).toMatchObject({ status: 'cleared', recordStatus: 'archived', frozenChargesFen: 15000, frozenFundsFen: 5000,
      currentChargesFen: 14000, currentFundsFen: 4800, remainingRefundFen: 0, remainingCollectFen: 0, reservedFen: 0 })
    expect(final.firstSettlement).toEqual(before.firstSettlement)
    expect(await s.summary()).toHaveProperty('outstandingFen', 0)
    expect(final.insurance).toEqual(replacement.insurance)
    expect(final.refunds).toHaveLength(1)
    expect(final.adjustments[0]).toMatchObject({ adjustmentId, amountFen: 1000, refundedFen: 200, status: 'completed' })
    expect(await s.frozen()).toEqual(frozen)
    expect(inpatientRecordSchema.parse(JSON.parse(frozen.recordJson)).archive).toEqual(s.archived.archive)
  }, 30_000)
  it('归档后医保补计产生真实待收，补收成功清除欠费且归档事实不变', async () => {
    const s = await setup(), before = await s.read(), frozen = await s.frozen()
    const adjusted = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments`, {
      chargeId: before.charges[0]!.chargeId, direction: 'increase', amountFen: 1000,
      expectedFingerprint: before.fingerprint, reason: '合成归档后床日费补计',
    })).json()).data
    expect(await s.summary()).toHaveProperty('outstandingFen', null)
    const adjustmentId = adjusted.adjustments[0]!.adjustmentId, insurancePath = `${s.path}/financial-adjustments/${adjustmentId}/insurance`
    const cancelled = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${insurancePath}/cancel`, {
      settlementId: s.original.id, expectedBalanceVersion: adjusted.insurance!.balance.version, expectedFingerprint: adjusted.fingerprint,
    })).json()).data
    const preview = insurancePreviewResponseSchema.parse(await (await s.request('cashier', `${insurancePath}/preview`, { expectedFingerprint: cancelled.fingerprint })).json()).data
    const replacement = inpatientFinancialResponseSchema.parse(await (await s.request('cashier', `${insurancePath}/confirm`, {
      previewId: preview.previewId, commitToken: preview.commitToken,
    })).json()).data
    expect(await s.summary()).toMatchObject({ outstandingFen: 200, recordStatus: 'archived', financialStatus: 'settled' })
    const payment = inpatientPaymentPreviewResponseSchema.parse(await (await s.request('cashier', `${s.path}/financial-adjustments/payments/preview`, {
      adjustmentId, amountFen: 200, expectedFingerprint: replacement.fingerprint,
      tenders: [{ method: 'cash', amountFen: 200 }], simulatorRule: 'success',
    })).json()).data
    await s.request('cashier', `${s.path}/financial-adjustments/payments/confirm`, { previewId: payment.previewId, commitToken: payment.commitToken })
    expect(await s.summary()).toHaveProperty('outstandingFen', 0)
    expect(await s.frozen()).toEqual(frozen)
  }, 30_000)
})
