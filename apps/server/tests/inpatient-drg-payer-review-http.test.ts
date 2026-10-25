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

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-drg-payer-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
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
  const base: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'),
    referenceDatabasePath, activeReferenceReleaseId: 'synthetic-clinical-2022', demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
  // 先无规则启动以读取确定性合成目录，再按实际术式/诊断码物化规则包并重启注入。
  let runtime = await createClinMeshRuntime(base)
  cleanups.push(async () => { await runtime.close() })
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
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'),
    cashier = await login('cashier'), insurance = await login('medical-insurance')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
        name: '合成核定患者', gender: 'male', birthDate: '1958-07-02', identifier: `SYN-${randomUUID()}`
      } }) })
  const patient = (await created.json()).data.patient
  const registered = await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()
  const admission = (await (await request(nurse, `/api/his/v1/inpatient/admissions/${registered.data.admission.id}/receive`, {
    encounterVersion: registered.data.admission.versionId, bedId: 'bed-general-1'
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const catalog = await (await request(doctor, '/api/his/v1/inpatient/surgery-catalog')).json()
  const groups = [
    { level: 'MDC', code: 'MDCA', name: '合成循环系统疾病', parentCode: null },
    { level: 'ADRG', code: 'RA1', name: '合成高血压组', parentCode: 'MDCA' },
    { level: 'DRG', code: 'RA15', name: '合成高血压组，不伴合并症或并发症', parentCode: 'RA1' },
    { level: 'ADRG', code: 'RA2', name: '合成PCI介入组', parentCode: 'MDCA' },
    { level: 'DRG', code: 'RA25', name: '合成PCI介入组，不伴合并症或并发症', parentCode: 'RA2' },
  ]
  const jsText = `return ["I10.x09"].includes(x.zdList[0])){Q("符合RA1入组条件，匹配规则：主诊断匹配");}return ["${catalog.procedures[0].coding.code}"].includes(x.ssList[0])){Q("符合RA2入组条件，匹配规则：主手术匹配");}`
  const drgRulesDirectory = join(directory, 'drg-rules')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(drgRulesDirectory, { recursive: true })
  const files = prepareDrgRulesPackage({ groups, jsText, complicationTables: { CC: {}, MCC: {}, CCE: {} },
    input: { openDrgJsSha256: 'a'.repeat(64), openDrgTablesSha256: 'b'.repeat(64), r3GroupsSha256: 'c'.repeat(64) },
    releaseId: 'chs-drg-payer-test', sourceVersion: 'CHS-DRG-3.0-payer-test' })
  for (const [name, content] of Object.entries(files)) await writeFile(join(drgRulesDirectory, name), content, 'utf8')
  await runtime.close()
  cleanups.pop()
  runtime = await createClinMeshRuntime({ ...base, drgRulesDirectory })
  cleanups.push(async () => { await runtime.close() })
  return { runtime, request, login, admission, doctor, nurse, cashier, insurance, registrar, path, catalog }
}

async function confirmPrimary(s: Awaited<ReturnType<typeof setup>>) {
  const clinical = await (await s.request(s.doctor, `${s.path}/clinical`)).json()
  return s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
    entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '核定验证诊断' }] })
}

/** 出科到可归档：签离→出科→结算→清床；首页提交、审核与归档由用例按主操作需求自行衔接。 */
async function finish(s: Awaited<ReturnType<typeof setup>>) {
  const admission = (await (await s.request(s.doctor, s.path)).json()).admission
  const issued = await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: admission.versionId, reason: '治疗完成' })).json()
  expect((await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issued.data.admission.versionId, reason: '已核对', departureMethod: 'home' })).status).toBe(200)
  const p = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
  const settled = await (await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: p.encounterVersion, fingerprint: p.fingerprint,
    expectedChargesFen: p.chargesFen, expectedBalanceFen: p.balanceFen })).json()
  expect((await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: settled.data.encounterVersion, reason: '床单位已清洁' })).status).toBe(200)
}

/** 提交首页并经病案审核通过后归档，返回归档时的来源哈希。 */
async function submitReviewArchive(s: Awaited<ReturnType<typeof setup>>, mainProcedureExecutionId: string | null) {
  const coder = await s.login('medical-records')
  const submitted = await (await s.request(s.doctor, `${s.path}/record`)).json()
  expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: submitted.revision?.revision ?? 0,
    expectedSourcesHash: submitted.sourcesHash, mainProcedureExecutionId })).status).toBe(200)
  const reviewed = await (await s.request(s.doctor, `${s.path}/record`)).json()
  expect((await s.request(coder, `${s.path}/record/review`, { expectedRevision: 1, expectedSourcesHash: reviewed.sourcesHash,
    outcome: 'approved', reason: '合成编码审核通过' })).status).toBe(200)
  const current = await (await s.request(s.doctor, `${s.path}/record`)).json()
  expect((await s.request(coder, `${s.path}/record/archive`, { expectedRevision: 1, expectedSourcesHash: current.sourcesHash })).status).toBe(200)
  return { sourcesHash: current.sourcesHash }
}

describe('住院 DRG 医保办模拟核定公共 HTTP', () => {
  it('核定先展示服务端金额预览，过期审阅被拒绝且原键重试仅留一份核定', async () => {
    const s = await setup()
    expect((await confirmPrimary(s)).status).toBe(200)
    await finish(s)
    await submitReviewArchive(s, null)
    const response = await s.request(s.insurance, `${s.path}/drg/payer-review-preview`)
    expect(response.status).toBe(200)
    const preview = await response.json()
    expect(preview).toMatchObject({ admissionId: s.admission.id, drgCode: 'RA15', simulatedPaymentFen: 300_000 })
    const stale = await s.request(s.insurance, `${s.path}/drg/payer-review`, {
      encounterVersion: preview.encounterVersion, expectedFingerprint: '0'.repeat(64), reason: '过期预览验证',
    })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error.code).toBe('INPATIENT_DRG_PAYER_PREVIEW_STALE')
    expect((await (await s.request(s.insurance, `${s.path}/drg/payer-reviews`)).json()).reviews).toEqual([])
    const input = { encounterVersion: preview.encounterVersion, expectedFingerprint: preview.fingerprint, reason: '已核对服务端预览' }
    const key = randomUUID()
    const confirmed = await s.request(s.insurance, `${s.path}/drg/payer-review`, input, key)
    expect(confirmed.status).toBe(200)
    const receipt = await confirmed.json()
    expect(await (await s.request(s.insurance, `${s.path}/drg/payer-review`, input, key)).json()).toEqual(receipt)
    expect(receipt.data.reviews).toHaveLength(1)
    expect(receipt.data.reviews[0]).toMatchObject({ simulatedPaymentFen: preview.simulatedPaymentFen,
      hospitalChargesFen: preview.hospitalChargesFen, differenceFen: preview.differenceFen })
  })

  it('医保办按合成参数核定归档病例，差异与依据可追溯，越岗读写被拒绝', async () => {
    const s = await setup()
    expect((await confirmPrimary(s)).status).toBe(200)
    await finish(s)
    const version = (await (await s.request(s.doctor, s.path)).json()).admission.versionId
    // 未归档病例不能模拟核定。
    expect((await s.request(s.insurance, `${s.path}/drg/payer-review`, { encounterVersion: version, expectedFingerprint: '0'.repeat(64), reason: '未归档验证' })).status).toBe(409)
    const { sourcesHash } = await submitReviewArchive(s, null)
    const preview = await (await s.request(s.insurance, `${s.path}/drg/payer-review-preview`)).json()
    // 越岗边界：医生与收费员不能发起核定，医生不能读取复核记录。
    expect((await s.request(s.doctor, `${s.path}/drg/payer-review`, { encounterVersion: version, expectedFingerprint: preview.fingerprint, reason: '越岗验证' })).status).toBe(403)
    expect((await s.request(s.cashier, `${s.path}/drg/payer-review`, { encounterVersion: version, expectedFingerprint: preview.fingerprint, reason: '越岗验证' })).status).toBe(403)
    const reviewed = await (await s.request(s.insurance, `${s.path}/drg/payer-review`, { encounterVersion: version, expectedFingerprint: preview.fingerprint, reason: '合成医保办复核' })).json()
    const archived = await (await s.request(s.doctor, `${s.path}/record`)).json()
    const chargesFen = archived.archive.snapshot.fees.chargesFen
    // 合成参数：基础费率 500000 分 × RA15 权重 6000bp = 300000 分。
    expect(reviewed.data.reviews).toEqual([expect.objectContaining({
      admissionId: s.admission.id, archiveSourcesHash: sourcesHash, recordRevision: 1,
      frozenRulesId: 'chs-drg-payer-test', frozenRulesVersion: 'CHS-DRG-3.0-payer-test',
      drgCode: 'RA15', simulatedPaymentFen: 300_000, hospitalChargesFen: chargesFen,
      differenceFen: 300_000 - chargesFen, reason: '合成医保办复核' })])
    expect(reviewed.data.reviews[0]!.note).toContain('合成支付参数')
    expect(reviewed.data.reviews[0]!.frozenResultHash).toMatch(/^[a-f0-9]{64}$/)
    // 冻结分组回看：医保办读取预分组获得归档冻结结果。
    expect((await (await s.request(s.insurance, `${s.path}/drg/pregroup`)).json())).toMatchObject({ frozen: true,
      result: { status: 'grouped', drgCode: 'RA15' } })
    // 追加复核保留原记录，病案可读，医生越岗读取被拒。
    expect((await s.request(s.insurance, `${s.path}/drg/payer-review`, { encounterVersion: version, expectedFingerprint: preview.fingerprint, reason: '第二次复核' })).status).toBe(200)
    const list = await (await s.request(s.insurance, `${s.path}/drg/payer-reviews`)).json()
    expect(list.reviews.map((row: { reason: string }) => row.reason)).toEqual(['合成医保办复核', '第二次复核'])
    expect((await (await s.request(await s.login('medical-records'), `${s.path}/drg/payer-reviews`)).status)).toBe(200)
    expect((await s.request(s.doctor, `${s.path}/drg/payer-reviews`)).status).toBe(403)
    expect((await s.request(s.cashier, `${s.path}/drg/payer-reviews`)).status).toBe(403)
    // 医保办不取得临床写入与患者收退款权限。
    expect((await s.request(s.insurance, `${s.path}/orders/issue`, { encounterVersion: '1', duration: 'temporary',
      selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1, doseText: '5 mg', frequencyCode: 'QD', doseQuantity: 1 } })).status).toBe(403)
  })

  it('冻结分组未确定病组或参数未覆盖时按缺口报告，不落核定记录', async () => {
    const s = await setup()
    expect((await confirmPrimary(s)).status).toBe(200)
    const procedure = s.catalog.procedures[0]
    const current = (await (await s.request(s.doctor, s.path)).json()).admission
    const request = (await (await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: current.versionId,
      procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成PCI核定' })).json()).data.requests[0]
    for (const [cookie, action] of [[s.nurse, 'check-preop'], [s.doctor, 'confirm-consent']] as const) {
      const version = (await (await s.request(s.doctor, `${s.path}/surgeries`)).json()).requests[0].version
      expect((await s.request(cookie, `${s.path}/surgeries/${action}`, { requestId: request.id, expectedRequestVersion: version, note: '合成准备完成' })).status).toBe(200)
    }
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, { requestId: request.id,
      expectedRequestVersion: (await (await s.request(s.doctor, `${s.path}/surgeries`)).json()).requests[0].version,
      procedureId: procedure.id, catalogVersion: procedure.version, note: '合成实际实施完成', materials: [] })).status).toBe(200)
    const execution = (await (await s.request(s.doctor, `${s.path}/surgeries`)).json()).executions[0]
    await finish(s)
    await submitReviewArchive(s, execution.id)
    const missingVersion = (await (await s.request(s.doctor, s.path)).json()).admission.versionId
    // RA25 不在合成参数覆盖范围：核定按参数缺口明确报告，不产生记录。
    const missing = await s.request(s.insurance, `${s.path}/drg/payer-review`, { encounterVersion: missingVersion, expectedFingerprint: '0'.repeat(64), reason: '参数缺口验证' })
    expect(missing.status).toBe(409)
    expect((await missing.json()).error.code).toBe('DRG_PAYMENT_PARAMETER_MISSING')
    expect((await (await s.request(s.insurance, `${s.path}/drg/payer-reviews`)).json()).reviews).toEqual([])
  })
})
