import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { prepareDrgRulesPackage } from '../../server/src/infrastructure/reference-data/drg-rules-prepare.ts'
import { syntheticDrgIdentity, syntheticDrgSource } from '../../server/tests/fixtures/drg-synthetic-program.ts'
import { runReferenceDatabaseCli } from '../../server/src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../../server/src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../../server/src/application/scenario-data/medical-service-snapshot.ts'
import { expect, test as base } from './fixtures.ts'

/** 合成规则只验证产品 wiring；固定 CHS-DRG PCI 分组由联合 HTTP 验收拥有。 */
export const test = base.extend({ browserApp: async ({ webRoot }, use) => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-browser-'))
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  const drgRulesDirectory = join(directory, 'rules')
  let app: Awaited<ReturnType<typeof startBrowserServer>> | undefined
  try {
    await mkdir(drgRulesDirectory)
    const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
      system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成页面高血压', status: 'active', sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457' }],
    medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
    await writeFile(join(directory, 'reference.json'), artifact)
    await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-drg-browser', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z', sources: [{
      sourceId: 'synthetic-clinical', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'CC0-1.0',
      retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
    await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
    await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
    const groups = [
      { level: 'MDC', code: 'MDCR', name: '合成循环系统', parentCode: null },
      { level: 'ADRG', code: 'RA1', name: '合成高血压', parentCode: 'MDCR' },
      { level: 'DRG', code: 'RA15', name: '合成页面病组', parentCode: 'RA1' },
      { level: 'ADRG', code: 'RA2', name: '合成操作候选', parentCode: 'MDCR' },
      { level: 'DRG', code: 'RA25', name: '合成操作病组', parentCode: 'RA2' },
    ]
    const jsText = syntheticDrgSource('I10.x09', 'RA15', '00.6600')
    const complicationTables = { CC: {}, MCC: {}, CCE: {} }
    const files = prepareDrgRulesPackage({ groups, jsText, complicationTables,
      input: syntheticDrgIdentity(jsText, groups, complicationTables), releaseId: 'synthetic-drg-browser', sourceVersion: 'synthetic-browser-2' })
    for (const [name, content] of Object.entries(files)) await writeFile(join(drgRulesDirectory, name), content, 'utf8')
    app = await startBrowserServer(webRoot, { referenceDatabasePath, activeReferenceReleaseId: 'synthetic-drg-browser', drgRulesDirectory, autoDispatchIntervalMs: 25 })
    await use(app)
  } finally { try { await app?.close() } finally { await rm(directory, { recursive: true, force: true }) } }
} })

export { expect }

export function drgBrowserApi(page: Pick<Page, 'request'>, app: { origin: string; password: string }) {
  const login = async (role: string) => expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, { headers: { origin: app.origin },
    data: { email: `${role}@demo.clinmesh.local`, password: app.password } })).status()).toBe(200)
  const post = (path: string, input: unknown, expectedVersions?: object) => page.request.post(app.origin + path, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input, ...(expectedVersions ? { expectedVersions } : {}) },
  })
  const get = (path: string) => page.request.get(app.origin + path)
  return { login, post, get }
}

export async function createDrgBrowserPatient(page: Pick<Page, 'request'>, app: { origin: string; password: string }, name = '合成DRG贯通患者') {
  const api = drgBrowserApi(page, app)
  await api.login('registrar')
  const patient = createPatientResponseSchema.parse(await (await api.post('/api/his/v1/patients', { name, gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` }, {})).json()).data.patient
  const registered = inpatientCommandResponseSchema.parse(await (await api.post('/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  await api.login('ward-nurse')
  expect((await api.post(`${path}/receive`, { encounterVersion: registered.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await api.login('inpatient-doctor')
  const clinical = inpatientFullClinicalSchema.parse(await (await api.get(`${path}/clinical`)).json())
  expect((await api.post(`${path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
    entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '合成页面确认诊断' }] })).status()).toBe(200)
  return { api, path, admissionId: registered.id, name }
}

export async function archiveDrgBrowserPatient(s: Awaited<ReturnType<typeof createDrgBrowserPatient>>) {
  const current = inpatientDetailSchema.parse(await (await s.api.get(s.path)).json()).admission
  const issued = inpatientCommandResponseSchema.parse(await (await s.api.post(`${s.path}/discharge/issue`, { encounterVersion: current.versionId, reason: '合成治疗完成' })).json()).data.admission
  await s.api.login('ward-nurse')
  expect((await s.api.post(`${s.path}/discharge/depart`, { encounterVersion: issued.versionId, reason: '合成出区核对', departureMethod: 'home' })).status()).toBe(200)
  await s.api.login('cashier')
  const { inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } = await import('@clinmesh/contracts/inpatient-discharge')
  const preview = inpatientSettlementPreviewSchema.parse(await (await s.api.get(`${s.path}/discharge/preview`)).json())
  const settled = inpatientSettlementResponseSchema.parse(await (await s.api.post(`${s.path}/discharge/settle`, { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })).json())
  await s.api.login('ward-nurse')
  expect((await s.api.post(`${s.path}/discharge/clear`, { encounterVersion: settled.data.encounterVersion, reason: '合成清床' })).status()).toBe(200)
  await s.api.login('inpatient-doctor')
  const record = inpatientRecordSchema.parse(await (await s.api.get(`${s.path}/record`)).json())
  expect((await s.api.post(`${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: record.sourcesHash, mainProcedureExecutionId: null })).status()).toBe(200)
  await s.api.login('medical-records')
  const submitted = inpatientRecordSchema.parse(await (await s.api.get(`${s.path}/record`)).json())
  expect((await s.api.post(`${s.path}/record/review`, { expectedRevision: 1, expectedSourcesHash: submitted.sourcesHash, outcome: 'approved', reason: '合成审核通过' })).status()).toBe(200)
  const reviewed = inpatientRecordSchema.parse(await (await s.api.get(`${s.path}/record`)).json())
  expect((await s.api.post(`${s.path}/record/archive`, { expectedRevision: 1, expectedSourcesHash: reviewed.sourcesHash })).status()).toBe(200)
}
