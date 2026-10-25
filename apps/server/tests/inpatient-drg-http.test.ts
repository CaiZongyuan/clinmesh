import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'
import { prepareDrgRulesPackage } from '../src/infrastructure/reference-data/drg-rules-package.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const groups = [
  { level: 'MDC', code: 'MDCA', name: '合成循环系统疾病', parentCode: null },
  { level: 'ADRG', code: 'RA1', name: '合成高血压组', parentCode: 'MDCA' },
  { level: 'DRG', code: 'RA15', name: '合成高血压组，不伴合并症或并发症', parentCode: 'RA1' },
]
const jsText = 'return ["I10.x09"].includes(x.zdList[0])){Q("符合RA1入组条件，匹配规则：主诊断匹配");}'

async function writeRulesPackage(releaseId = 'chs-drg-pregroup-test', sourceVersion = 'CHS-DRG-3.0-pregroup-test'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-pregroup-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const files = prepareDrgRulesPackage({ groups, jsText, complicationTables: { CC: {}, MCC: {}, CCE: {} },
    input: { openDrgJsSha256: 'a'.repeat(64), openDrgTablesSha256: 'b'.repeat(64), r3GroupsSha256: 'c'.repeat(64) },
    releaseId, sourceVersion })
  for (const [path, content] of Object.entries(files)) await writeFile(join(directory, path), content, 'utf8')
  return directory
}

async function setup(drgRulesDirectory?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-drg-'))
  cleanups.push(async () => { await rm(directory, { recursive: true }) })
  const password = `Test-${randomUUID()}-Aa1!`
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
        system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成真实目录高血压', status: 'active', sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457' }],
      medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
  await writeFile(join(directory, 'reference.json'), artifact)
  await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-clinical-2022', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z',
    sources: [{ sourceId: 'synthetic-clinical', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'CC0-1.0',
        retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'),
    referenceDatabasePath, activeReferenceReleaseId: 'synthetic-clinical-2022', demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'], ...(drgRulesDirectory === undefined ? {} : { drgRulesDirectory }) }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close() })
  /** 以新的规则包目录重启同一数据库，用于验证归档冻结结果不随规则升级变化。 */
  const reopen = async (nextRulesDirectory?: string) => {
    await runtime.close()
    runtime = await createClinMeshRuntime({ ...options, ...(nextRulesDirectory === undefined ? {} : { drgRulesDirectory: nextRulesDirectory }) })
  }
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
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), cashier = await login('cashier')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
        name: '合成预分组患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`
      } }) })
  const patient = (await created.json()).data.patient
  const registered = (await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const admission = (await (await request(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1'
  })).json()).data.admission
  return { runtime, reopen, request, login, patient, admission, doctor, nurse, cashier, registrar, path: `/api/his/v1/inpatient/admissions/${admission.id}` }
}

async function confirmPrimary(s: Awaited<ReturnType<typeof setup>>) {
  const clinical = await (await s.request(s.doctor, `${s.path}/clinical`)).json()
  return s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
    entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '预分组验证诊断' }] })
}

async function finish(s: Awaited<ReturnType<typeof setup>>) {
  const admission = (await (await s.request(s.doctor, s.path)).json()).admission
  const issued = await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: admission.versionId, reason: '治疗完成' })).json()
  expect((await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issued.data.admission.versionId, reason: '已核对', departureMethod: 'home' })).status).toBe(200)
  const p = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
  const settled = await (await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: p.encounterVersion, fingerprint: p.fingerprint,
    expectedChargesFen: p.chargesFen, expectedBalanceFen: p.balanceFen })).json()
  expect((await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: settled.data.encounterVersion, reason: '床单位已清洁' })).status).toBe(200)
}

describe('住院病案 DRG 预分组公共 HTTP', () => {
  it('已提交病案按首页快照预分组，结果标注双轨口径、规则版本与判定路径', async () => {
    const s = await setup(await writeRulesPackage())
    expect((await confirmPrimary(s)).status).toBe(200)
    await finish(s)
    const draft = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: draft.sourcesHash, mainProcedureExecutionId: null })).status).toBe(200)
    const response = await s.request(s.doctor, `${s.path}/drg/pregroup`)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ admissionId: s.admission.id, recordRevision: 1, rulesId: 'chs-drg-pregroup-test', rulesVersion: 'CHS-DRG-3.0-pregroup-test',
      inputCoding: 'nhc-icd10-clinical@2022.r4', result: { status: 'grouped', drgCode: 'RA15', mdcCode: 'MDCA', adrgCode: 'RA1' } })
    expect(result.codingNote).toContain('临床版')
    expect(result.result.steps.map((step: { stage: string }) => step.stage)).toEqual(['mdc', 'adrg', 'drg'])
  })

  it('在院未提交首页也读取当前正式诊断预分组；未配置规则包时明确报错', async () => {
    const s = await setup(await writeRulesPackage())
    expect((await confirmPrimary(s)).status).toBe(200)
    const missing = await s.request(s.doctor, `${s.path}/drg/pregroup`)
    expect(missing.status).toBe(200)
    expect(await missing.json()).toMatchObject({ recordRevision: 0, frozen: false,
      result: { status: 'grouped', drgCode: 'RA15' } })
    const bare = await setup()
    const unconfigured = await bare.request(bare.doctor, `${bare.path}/drg/pregroup`)
    expect(unconfigured.status).toBe(409)
    expect((await unconfigured.json()).error.code).toBe('DRG_RULES_NOT_CONFIGURED')
    // 规则包未配置不阻塞归档；归档病例预分组明确报告缺冻结结果。
    expect((await confirmPrimary(bare)).status).toBe(200)
    await finish(bare)
    const bareDraft = await (await bare.request(bare.doctor, `${bare.path}/record`)).json()
    expect((await bare.request(bare.doctor, `${bare.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: bareDraft.sourcesHash, mainProcedureExecutionId: null })).status).toBe(200)
    const bareCoder = await bare.login('medical-records')
    const bareReviewed = await (await bare.request(bare.doctor, `${bare.path}/record`)).json()
    expect((await bare.request(bareCoder, `${bare.path}/record/review`, { expectedRevision: 1, expectedSourcesHash: bareReviewed.sourcesHash,
      outcome: 'approved', reason: '合成编码审核通过' })).status).toBe(200)
    const bareCurrent = await (await bare.request(bare.doctor, `${bare.path}/record`)).json()
    expect((await bare.request(bareCoder, `${bare.path}/record/archive`, { expectedRevision: 1, expectedSourcesHash: bareCurrent.sourcesHash })).status).toBe(200)
    const bareFrozen = await bare.request(bare.doctor, `${bare.path}/drg/pregroup`)
    expect(bareFrozen.status).toBe(409)
    expect((await bareFrozen.json()).error.code).toBe('DRG_FROZEN_RESULT_MISSING')
  })

  it('归档冻结分组：结果绑定归档时规则版本，更换规则包后预分组不再变化', async () => {
    const s = await setup(await writeRulesPackage())
    expect((await confirmPrimary(s)).status).toBe(200)
    await finish(s)
    const submitted = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: submitted.sourcesHash, mainProcedureExecutionId: null })).status).toBe(200)
    const coder = await s.login('medical-records')
    const reviewed = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(coder, `${s.path}/record/review`, { expectedRevision: 1, expectedSourcesHash: reviewed.sourcesHash,
      outcome: 'approved', reason: '合成编码审核通过' })).status).toBe(200)
    const current = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(coder, `${s.path}/record/archive`, { expectedRevision: 1, expectedSourcesHash: current.sourcesHash })).status).toBe(200)
    const frozen = await (await s.request(s.doctor, `${s.path}/drg/pregroup`)).json()
    expect(frozen).toMatchObject({ frozen: true, recordRevision: 1, rulesId: 'chs-drg-pregroup-test', rulesVersion: 'CHS-DRG-3.0-pregroup-test',
      result: { status: 'grouped', drgCode: 'RA15' } })
    // 升级规则包重启后，归档病例仍返回归档时的冻结结果与规则身份。
    await s.reopen(await writeRulesPackage('chs-drg-pregroup-test-v2', 'CHS-DRG-3.0-pregroup-test-v2'))
    const afterUpgrade = await (await s.request(s.doctor, `${s.path}/drg/pregroup`)).json()
    expect(afterUpgrade).toEqual(frozen)
  })
})
