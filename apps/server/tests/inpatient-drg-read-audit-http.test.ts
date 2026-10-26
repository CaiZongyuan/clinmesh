import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { apiErrorSchema, commandResponseSchema, createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientMaterialReservationListSchema, inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgPayerReviewListSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSettlementPreviewSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientSurgeryCatalogSchema } from '@clinmesh/contracts/inpatient-surgery'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { prepareDrgRulesPackage } from '../src/infrastructure/reference-data/drg-rules-prepare.ts'
import { syntheticDrgIdentity, syntheticDrgSource } from './fixtures/drg-synthetic-program.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const reads = [
  { suffix: 'pregroup', operation: 'inpatient.drg.pregroup' },
  { suffix: 'simulation', operation: 'inpatient.drg.simulate', input: { medications: [], services: [] } },
  { suffix: 'reservations', operation: 'inpatient.drg.reservations.read' },
  { suffix: 'payer-reviews', operation: 'inpatient.drg.payer-reviews.read' },
]

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-read-audit-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
    system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成高血压', status: 'active', sourceLocator: 'synthetic:diagnosis:1' }],
  medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
  await writeFile(join(directory, 'reference.json'), artifact)
  await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-drg-audit', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z',
    sources: [{ sourceId: 'synthetic-clinical', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'),
      licenseId: 'CC0-1.0', retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  const drgRulesDirectory = join(directory, 'drg-rules')
  await mkdir(drgRulesDirectory)
  const groups = [
    { level: 'MDC', code: 'MDCR', name: '合成系统', parentCode: null },
    { level: 'ADRG', code: 'RA1', name: '合成高血压组', parentCode: 'MDCR' },
    { level: 'DRG', code: 'RA15', name: '合成高血压组，不伴合并症或并发症', parentCode: 'RA1' },
  ]
  const jsText = syntheticDrgSource(), complicationTables = { CC: {}, MCC: {}, CCE: {}, SS_VALID: [] }
  const files = prepareDrgRulesPackage({ groups, jsText, complicationTables,
    input: syntheticDrgIdentity(jsText, groups, complicationTables),
    releaseId: 'synthetic-drg-audit', sourceVersion: 'synthetic-v2-audit-test' })
  for (const [name, content] of Object.entries(files)) await writeFile(join(drgRulesDirectory, name), content)
  const drgRulesReviewPath = join(directory, 'synthetic-review.json')
  const evidence = { status: 'verified', evidence: ['synthetic:read-audit-fixture'] }
  await writeFile(drgRulesReviewPath, JSON.stringify({ schemaVersion: 'clinmesh.drg-rules-review.v1', scope: 'hospital-simulation',
    releaseId: 'synthetic-drg-audit', sourceVersion: 'synthetic-v2-audit-test',
    manifestSha256: createHash('sha256').update(files['manifest.json']!).digest('hex'), referenceReleaseId: 'synthetic-drg-audit',
    reviewedBy: 'synthetic-test-reviewer', reviewedAt: '2026-10-26T00:00:00.000Z',
    checks: { usageTerms: evidence, codingCompatibility: evidence, sourceApplicability: evidence, algorithmValidation: evidence } }))
  const password = `Test-${randomUUID()}-Aa1!`
  const runtime = await createClinMeshRuntime({ authBaseUrl: 'http://localhost', trustedOrigins: ['http://localhost'], demoPassword: password,
    authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'hospital.sqlite'), referenceDatabasePath, activeReferenceReleaseId: 'synthetic-drg-audit',
    drgRulesDirectory, drgRulesReviewPath, migrationMode: 'apply' })
  cleanups.push(() => runtime.close())
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, expectedVersions?: Record<string, string>) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': randomUUID() },
    ...(input === undefined ? {} : { body: JSON.stringify({ input, ...(expectedVersions === undefined ? {} : { expectedVersions }) }) }) })
  }
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), admin = await login('admin')
  const created = await request(registrar, '/api/his/v1/patients', {
    name: '合成 DRG 审计患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` }, {})
  expect(created.status).toBe(200)
  const patient = createPatientResponseSchema.parse(await created.json()).data.patient
  const registered = await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 })
  expect(registered.status).toBe(200)
  const admission = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
  const audits = async (operation: string) => {
    const response = await request(admin, '/fhir/R5/AuditEvent?_count=100')
    expect(response.status).toBe(200)
    const bundle = fhirBundleSchema.parse(await response.json())
    const schema = z.object({ action: z.string(), code: z.object({ text: z.string() }),
      outcome: z.object({ code: z.object({ code: z.string() }) }) })
    return bundle.entry?.map(entry => schema.parse(entry.resource)).filter(audit => audit.code.text === operation) ?? []
  }
  return { runtime, request, login, doctor, registrar, admission, audits, path: `/api/his/v1/inpatient/admissions/${admission.id}` }
}

async function submitRecord(s: Awaited<ReturnType<typeof setup>>) {
  const nurse = await s.login('ward-nurse'), cashier = await s.login('cashier')
  const received = await s.request(nurse, `${s.path}/receive`, { encounterVersion: s.admission.versionId, bedId: 'bed-general-1' })
  expect(received.status).toBe(200)
  inpatientCommandResponseSchema.parse(await received.json())
  const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
  expect((await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
    entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '合成审计诊断' }] })).status).toBe(200)
  const admission = inpatientDetailSchema.parse(await (await s.request(s.doctor, s.path)).json()).admission
  const issued = await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: admission.versionId, reason: '合成治疗完成' })
  expect(issued.status).toBe(200)
  const discharged = inpatientCommandResponseSchema.parse(await issued.json()).data.admission
  expect((await s.request(nurse, `${s.path}/discharge/depart`, { encounterVersion: discharged.versionId, reason: '合成出区核对', departureMethod: 'home' })).status).toBe(200)
  const preview = inpatientSettlementPreviewSchema.parse(await (await s.request(cashier, `${s.path}/discharge/preview`)).json())
  const settled = await s.request(cashier, `${s.path}/discharge/settle`, { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint,
    expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })
  expect(settled.status).toBe(200)
  const current = inpatientSettlementPreviewSchema.parse((await settled.json()).data)
  expect((await s.request(nurse, `${s.path}/discharge/clear`, { encounterVersion: current.encounterVersion, reason: '合成清床' })).status).toBe(200)
  const record = inpatientRecordSchema.parse(await (await s.request(s.doctor, `${s.path}/record`)).json())
  expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: record.sourcesHash, mainProcedureExecutionId: null })).status).toBe(200)
}

describe('DRG 读取公共 HTTP 审计', () => {
  it('耗材预留读取通过公开 AuditEvent 追溯且不改变临床版本', async () => {
    const s = await setup()
    const response = await s.request(s.doctor, `${s.path}/drg/reservations`)
    expect(response.status).toBe(200)
    const result = inpatientMaterialReservationListSchema.parse(await response.json())
    expect(result).toEqual({ admissionId: s.admission.id, encounterVersion: s.admission.versionId, reservations: [] })
    expect(await s.audits('inpatient.drg.reservations.read')).toEqual([
      expect.objectContaining({ action: 'R', outcome: { code: { code: '0' } } }),
    ])
  })

  it('预分组、推演与医保办复核读取保留成功审计且不改变冻结依据', async () => {
    const s = await setup(), insurance = await s.login('medical-insurance')
    await submitRecord(s)
    const before = inpatientRecordSchema.parse(await (await s.request(s.doctor, `${s.path}/record`)).json())
    const pregroup = await s.request(s.doctor, `${s.path}/drg/pregroup`)
    expect(pregroup.status).toBe(200)
    expect(inpatientDrgPregroupResultSchema.parse(await pregroup.json()).result).toMatchObject({ status: 'grouped', drgCode: 'RA15' })
    const simulation = await s.request(s.doctor, `${s.path}/drg/simulation`, { medications: [], services: [] })
    expect(simulation.status).toBe(200)
    const evaluated = inpatientDrgSimulationSchema.parse(await simulation.json())
    const reviews = await s.request(insurance, `${s.path}/drg/payer-reviews`)
    expect(reviews.status).toBe(200)
    expect(inpatientDrgPayerReviewListSchema.parse(await reviews.json()).reviews).toEqual([])
    for (const operation of ['inpatient.drg.pregroup', 'inpatient.drg.simulate', 'inpatient.drg.payer-reviews.read']) {
      expect(await s.audits(operation)).toEqual([expect.objectContaining({ action: 'R', outcome: { code: { code: '0' } } })])
    }
    expect(inpatientRecordSchema.parse(await (await s.request(s.doctor, `${s.path}/record`)).json())).toEqual(before)
    const repeated = inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/simulation`, { medications: [], services: [] })).json())
    expect(repeated.fingerprint).toBe(evaluated.fingerprint)
  })

  it('四类读取的越岗拒绝均有失败审计，医保办不能读取医生推演或耗材预留', async () => {
    const s = await setup(), insurance = await s.login('medical-insurance')
    for (const { suffix, operation, input } of reads) {
      const response = await s.request(s.registrar, `${s.path}/drg/${suffix}`, input)
      expect(response.status).toBe(403)
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe('INPATIENT_ROLE_FORBIDDEN')
      expect(await s.audits(operation)).toEqual([expect.objectContaining({ action: 'R', outcome: { code: { code: '8' } } })])
    }
    for (const { suffix, input } of reads.filter(read => ['simulation', 'reservations'].includes(read.suffix))) {
      const response = await s.request(insurance, `${s.path}/drg/${suffix}`, input)
      expect(response.status).toBe(403)
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe('INPATIENT_ROLE_FORBIDDEN')
    }
  })

  it('审计存储失败时四类成功读取不返回未审计数据，越岗拒绝保持原语义', async () => {
    const s = await setup(), insurance = await s.login('medical-insurance')
    await submitRecord(s)
    // 仅向临时 SQLite 的审计存储注入故障，认证、领域查询与 HTTP 映射均为真实实现。
    s.runtime.database.driver.exec(`CREATE TEMP TRIGGER reject_drg_read_audit BEFORE INSERT ON audit_log
      WHEN NEW.operation IN ('inpatient.drg.pregroup','inpatient.drg.simulate','inpatient.drg.reservations.read','inpatient.drg.payer-reviews.read')
      BEGIN SELECT RAISE(ABORT,'synthetic read audit unavailable'); END`)
    for (const { suffix, operation, input } of reads) {
      const cookie = suffix === 'payer-reviews' ? insurance : s.doctor
      const response = await s.request(cookie, `${s.path}/drg/${suffix}`, input)
      expect(response.status).toBe(500)
      const error = apiErrorSchema.parse(await response.json())
      expect(error.error.code).toBe('INTERNAL_ERROR')
      expect(await s.audits(operation)).toEqual([])
      const denied = await s.request(s.registrar, `${s.path}/drg/${suffix}`, input)
      expect(denied.status).toBe(403)
      expect(apiErrorSchema.parse(await denied.json()).error.code).toBe('INPATIENT_ROLE_FORBIDDEN')
    }
  })

  it('预留创建和释放只保留业务 Command 审计，不另算外部读取', async () => {
    const s = await setup(), nurse = await s.login('ward-nurse')
    const received = await s.request(nurse, `${s.path}/receive`, { encounterVersion: s.admission.versionId, bedId: 'bed-general-1' })
    expect(received.status).toBe(200)
    const admission = inpatientCommandResponseSchema.parse(await received.json()).data.admission
    const catalog = inpatientSurgeryCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json())
    const material = catalog.materials.find(item => 'chargeDefinition' in item)!
    const created = await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: admission.versionId,
      materialId: material.id, catalogVersion: material.version, quantity: 1, reason: '合成预留验证' })
    expect(created.status).toBe(200)
    const resultSchema = commandResponseSchema(inpatientMaterialReservationListSchema)
    const reserved = resultSchema.parse(await created.json()).data
    expect(reserved.reservations[0]?.status).toBe('reserved')
    const released = await s.request(s.doctor, `${s.path}/drg/reservations/${reserved.reservations[0]!.id}/release`, {
      encounterVersion: reserved.encounterVersion, reason: '合成释放验证' })
    expect(released.status).toBe(200)
    expect(resultSchema.parse(await released.json()).data.reservations[0]?.status).toBe('released')
    expect(await s.audits('inpatient.drg.reservation.create')).toEqual([expect.objectContaining({ action: 'E', outcome: { code: { code: '0' } } })])
    expect(await s.audits('inpatient.drg.reservation.release')).toEqual([expect.objectContaining({ action: 'E', outcome: { code: { code: '0' } } })])
    expect(await s.audits('inpatient.drg.reservations.read')).toEqual([])
  })

  it('completed Run 允许医保办人类会话回查复核记录，不恢复核定写权限', async () => {
    const s = await setup(), insurance = await s.login('medical-insurance')
    // 复用既有住院归档测试的存量 Run 生命周期 fixture；结果仍经真实认证 HTTP 读取。
    s.runtime.database.driver.prepare("UPDATE scenario_run SET status='completed' WHERE scenario_run_id='scenario-run-1'").run()
    const read = await s.request(insurance, `${s.path}/drg/payer-reviews`)
    expect(read.status).toBe(200)
    expect(inpatientDrgPayerReviewListSchema.parse(await read.json())).toEqual({ admissionId: s.admission.id, reviews: [] })
    expect(await s.audits('inpatient.drg.payer-reviews.read')).toEqual([
      expect.objectContaining({ action: 'R', outcome: { code: { code: '0' } } }),
    ])
    const write = await s.request(insurance, `${s.path}/drg/payer-review`, { encounterVersion: s.admission.versionId, expectedFingerprint: '0'.repeat(64), reason: '合成越界核定' })
    expect(write.status).toBe(409)
    expect(apiErrorSchema.parse(await write.json()).error.code).toBe('CONTEXT_INACTIVE')
  })
})
