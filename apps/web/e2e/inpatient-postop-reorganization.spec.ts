import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  registrationCatalogSchema,
  scenarioCommandResponseSchema,
  scenarioStateSchema,
  sessionContextSchema,
} from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { startSyntheticCaseResultSchema, syntheticCaseInstanceSchema } from '@clinmesh/contracts/scenario'
import { sourceArtifactHash } from '../../server/src/application/scenario-data/provider.ts'
import { runReferenceDatabaseCli } from '../../server/src/reference-database-cli.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { expect, test as base } from './fixtures.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

const wstSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
const panelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
const datasetReleaseId = 'laboratory-cn@2026-09-01.r1'

async function createPostopReferenceDatabase(directory: string) {
  const rangeRule = (low: number, high: number, sex: 'all' | 'female' | 'male' = 'all') => ({
    high,
    low,
    notes: '合成成人参考区间',
    referenceKind: 'range' as const,
    sex,
    simulationHigh: high,
    simulationLow: low,
    sourceLocation: '表 1',
    sourceStandard: 'WS/T 886-2026',
    sourceType: 'national-standard' as const,
    sourceVersion: '2026',
  })
  const upperRule = (high: number, simulationLow: number, sex: 'all' | 'female' | 'male' = 'all') => ({
    high,
    notes: '合成成人参考上限',
    referenceKind: 'upper-bound' as const,
    sex,
    simulationHigh: high,
    simulationLow,
    sourceLocation: '表 1',
    sourceStandard: 'WS/T 886-2026',
    sourceType: 'project-curated' as const,
    sourceVersion: '2026-09-01',
  })
  const testItem = (
    code: string,
    display: string,
    specimen: string,
    unitCode: string,
    precision: number,
    rules: Array<ReturnType<typeof rangeRule> | ReturnType<typeof upperRule>>,
  ) => ({
    concept: {
      code,
      display,
      domain: 'laboratory' as const,
      id: `wst-886:2026:${code}`,
      sourceLocator: `synthetic:laboratory-cn:test:${code}`,
      status: 'active' as const,
      system: wstSystem,
      version: '2026',
    },
    definition: {
      adultReferenceRules: rules,
      alternateCodings: [],
      analyte: display,
      category: '临床检验',
      conceptId: `wst-886:2026:${code}`,
      datasetReleaseId,
      healthyStrategy: 'uniform' as const,
      kind: 'laboratory-cn-test' as const,
      precision,
      resultKind: 'quantity' as const,
      scale: '定量',
      sourceLocator: `synthetic:laboratory-cn:test:${code}`,
      sourceVersion: '2026',
      specimen,
      unit: { code: unitCode, display: unitCode, system: 'http://unitsofmeasure.org' as const },
    },
  })
  const panelItem = (code: string, display: string, specimen: string, memberCodes: string[]) => ({
    concept: {
      code,
      display,
      domain: 'laboratory' as const,
      id: `laboratory-panel-cn:2026-09-01:${code}`,
      sourceLocator: `synthetic:laboratory-cn:panel:${code}`,
      status: 'active' as const,
      system: panelSystem,
      version: '2026-09-01',
    },
    definition: {
      conceptId: `laboratory-panel-cn:2026-09-01:${code}`,
      datasetReleaseId,
      kind: 'laboratory-cn-panel' as const,
      notes: display,
      sourceLocation: '检验组合',
      sourceLocator: `synthetic:laboratory-cn:panel:${code}`,
      sourceType: 'project-authored' as const,
      sourceVersion: '2026-09-01',
      specimen,
    },
    members: memberCodes.map((memberCode, index) => ({
      memberConceptId: `wst-886:2026:${memberCode}`,
      memberOrder: index + 1,
      panelConceptId: `laboratory-panel-cn:2026-09-01:${code}`,
      relationship: 'contains' as const,
      sourceLocator: `synthetic:laboratory-cn:panel:${code}:${index + 1}`,
    })),
  })

  const tests = [
    testItem('0100101A', '白细胞计数', '全血', '10*9/L', 2, [rangeRule(3.5, 9.5)]),
    testItem('0100301A', '血红蛋白测定', '全血', 'g/L', 0, [rangeRule(130, 175, 'male'), rangeRule(115, 150, 'female')]),
    testItem('0100401A', '血小板计数', '全血', '10*9/L', 0, [rangeRule(125, 350)]),
    testItem('2100404B', '高敏心肌肌钙蛋白I测定', '血清、血浆', 'ng/L', 1, [upperRule(34.2, 2.0, 'male'), upperRule(15.6, 1.5, 'female')]),
    testItem('1700204A', '尿素测定', '血清、血浆', 'mmol/L', 2, [rangeRule(2.8, 7.6)]),
    testItem('1700404A', '肌酐测定', '血清、血浆', 'umol/L', 0, [rangeRule(57, 97, 'male'), rangeRule(41, 73, 'female')]),
    testItem('1400205A', '钠测定', '血清、血浆', 'mmol/L', 1, [rangeRule(137, 147)]),
    testItem('1400605A', '钾测定', '血清、血浆', 'mmol/L', 2, [rangeRule(3.5, 5.3)]),
  ]
  const panels = [
    panelItem('CN-LAB-CBC-5DIFF', '血常规（五分类）', '全血', ['0100101A', '0100301A', '0100401A']),
    panelItem('CN-LAB-RENAL', '肾功能组合', '血清、血浆', ['1700204A', '1700404A']),
    panelItem('CN-LAB-ELECTROLYTES', '电解质组合', '血清、血浆', ['1400205A', '1400605A']),
  ]
  const diagnosisConcepts = [
    { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', row: 12670 },
    { code: 'I10.x09', display: '高血压', row: 12457 },
    { code: 'K80.200', display: '胆囊结石', row: 14120 },
  ].map(({ code, display, row }) => ({
    code,
    display,
    domain: 'diagnosis' as const,
    id: `nhsa-diagnosis:nhc-icd10-clinical@2022.r4:${code}`,
    sourceLocator: `cn-health:nhc-icd10-clinical@2022.r4:diagnosis:${row}`,
    status: 'active' as const,
    system: 'urn:clinmesh:reference:nhsa-diagnosis',
    version: '2022',
  }))
  const artifactJson = `${JSON.stringify({
    concepts: [...diagnosisConcepts, ...tests.map(item => item.concept), ...panels.map(item => item.concept)],
    laboratoryDefinitions: [...tests.map(item => item.definition), ...panels.map(item => item.definition)],
    laboratoryPanelMembers: panels.flatMap(item => item.members),
    laboratorySpecimens: [],
    laboratoryUnits: [],
    schemaVersion: '1',
  })}\n`
  await writeFile(join(directory, 'postop-reference.json'), artifactJson)
  const manifestPath = join(directory, 'postop-manifest.json')
  await writeFile(manifestPath, `${JSON.stringify({
    createdAt: '2026-09-02T00:00:00.000Z',
    releaseId: 'postop-e2e-reference-v1',
    schemaVersion: '1',
    sources: [{
      acquisitionMethod: 'generated',
      artifactPath: 'postop-reference.json',
      checksum: createHash('sha256').update(artifactJson).digest('hex'),
      licenseId: 'LicenseRef-Synthetic-Test',
      retrievedAt: '2026-09-02T00:00:00.000Z',
      sourceId: 'cn-health-laboratory-cn',
      sourceUrl: 'https://example.test/laboratory-cn',
      upstreamVersion: '2026-09-01',
    }],
  })}\n`)
  const databasePath = join(directory, 'reference.sqlite')
  await runReferenceDatabaseCli(['migrate', '--database', databasePath])
  await runReferenceDatabaseCli(['import', '--database', databasePath, '--manifest', manifestPath])
  return databasePath
}

const test = base.extend<{ postopApp: Awaited<ReturnType<typeof startBrowserServer>> }>({
  postopApp: async ({ webRoot }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-postop-e2e-'))
    let patientCounter = 0
    try {
      const referenceDatabasePath = await createPostopReferenceDatabase(directory)
      const app = await startBrowserServer(webRoot, {
        activeReferenceReleaseId: 'postop-e2e-reference-v1',
        chatCompletionsProvider: {
          completeJson: async input => ({
            content: JSON.stringify({
              chiefComplaint: '围术期合成病例',
              knownHistorySummary: '既往高血压病史。',
              medicationMemory: '规律服药。',
              openingStatement: '医生您好，我来做手术治疗。',
              persona: { attitude: '配合', character: '温和', healthLiteracy: '一般', speechStyle: '清晰' },
              symptomExperience: '间断不适。',
            }),
            model: input.model,
          }),
        },
        patientPersonaModel: 'synthetic-persona',
        referenceDatabasePath,
        syntheaProvider: {
          capabilities: async () => ({ available: true, maxPopulation: 1, modules: [], providerId: 'synthea', providerName: 'Synthea' }),
          generate: async () => {
            patientCounter += 1
            const pid = `postop-patient-${patientCounter}`
            const name = patientCounter === 1 ? '合成普外停嘱患者' : '合成冠脉续嘱患者'
            const bundle = {
              entry: [
                { fullUrl: 'urn:uuid:patient', resource: { birthDate: '1965-04-12', gender: 'male', id: pid, name: [{ text: name }], resourceType: 'Patient' } },
                { fullUrl: 'urn:uuid:encounter', resource: { id: `enc-${pid}`, period: { end: '2026-06-01T10:30:00+08:00', start: '2026-06-01T10:00:00+08:00' }, reasonCode: [{ text: '择期住院手术' }], resourceType: 'Encounter', status: 'finished', subject: { reference: 'urn:uuid:patient' } } },
                { fullUrl: 'urn:uuid:condition', resource: { code: { coding: [{ code: '386661006', display: '2 型糖尿病', system: 'http://snomed.info/sct' }] }, encounter: { reference: 'urn:uuid:encounter' }, id: `cond-${pid}`, recordedDate: '2026-06-01T10:05:00+08:00', resourceType: 'Condition', subject: { reference: 'urn:uuid:patient' } } },
              ],
              resourceType: 'Bundle',
              type: 'collection',
            }
            return { kind: 'synthea-r4', sources: [{ format: 'fhir-r4-bundle', hash: sourceArtifactHash(bundle), patientId: pid, raw: bundle }] }
          },
        },
      })
      try { await use(app) } finally { await app.close() }
    } finally { await rm(directory, { force: true, recursive: true }) }
  },
})

async function loginUi(page: Page, origin: string, password: string, account: string, first = false) {
  if (!first) {
    await page.getByRole('button', { name: '用户菜单' }).click()
    await page.getByRole('menuitem', { name: '退出登录' }).click()
  }
  await page.getByLabel('账户邮箱').fill(`${account}@demo.clinmesh.local`)
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  await expect(page.locator('.clinmesh-web-root')).toBeVisible()
  void origin
}

test('手术停续策略与术后成套医嘱重整走真实浏览器入口（普外全麻自动停长嘱重整 + PCI 续用术前长嘱跳过已在用）', async ({ page, postopApp }) => {
  test.setTimeout(180_000)
  const origin = postopApp.origin
  const postInput = async (path: string, input: unknown) => page.request.post(`${origin}${path}`, {
    data: { input },
    headers: { 'idempotency-key': randomUUID(), origin },
  })
  const postRaw = async (path: string, data: unknown) => page.request.post(`${origin}${path}`, {
    data,
    headers: { 'idempotency-key': randomUUID(), origin },
  })

  await page.goto(`${origin}/registration`)
  await loginUi(page, origin, postopApp.password, 'admin', true)
  const currentScenario = scenarioStateSchema.parse(await (await page.request.get(`${origin}/api/sim/v1/scenario-runs/current`)).json())
  expect(scenarioCommandResponseSchema.parse(await (await postRaw(`/api/sim/v1/scenario-runs/${currentScenario.scenarioRunId}/actions/reset`, {})).json()).data.epoch).toBe('epoch-2')

  const admitSyntheticPatient = async (bedId: string) => {
    expect((await postRaw('/api/sim/v1/scenario-generation-jobs', {
      name: `术后重整病例-${bedId}`,
      population: { age: { maximum: 75, minimum: 18 }, count: 1, gender: 'any' },
      providerId: 'synthea',
      seeds: { clinical: Math.floor(Math.random() * 100_000) + 1, population: Math.floor(Math.random() * 100_000) + 1 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    })).status()).toBe(200)
    const generated = await postopApp.runtime.scenarioData.processNextGenerationJob()
    const caseId = generated!.caseIds[0]!
    expect((await postRaw(`/api/sim/v1/synthetic-cases/${caseId}/patient-persona-jobs`, {})).status()).toBe(200)
    expect((await postopApp.runtime.patientPersona.processNext())?.status).toBe('succeeded')
    const sc = syntheticCaseInstanceSchema.parse(await (await page.request.get(`${origin}/api/sim/v1/synthetic-cases/${caseId}`)).json())
    const regCatalog = registrationCatalogSchema.parse(await (await page.request.get(`${origin}/api/his/v1/catalogs/registration`)).json())
    const started = (await (await postRaw(`/api/his/v1/synthetic-cases/${caseId}/actions/start-outpatient-visit`, {
      activeBriefRevision: sc.activeBriefRevision,
      departmentId: regCatalog.departments[0]!.id,
      expectedCaseRevision: sc.revision,
      locationId: regCatalog.locations[0]!.id,
      visitDate: regCatalog.virtualDate,
      visitTypeId: regCatalog.visitTypes[0]!.id,
    })).json()) as { data: unknown }
    const patientId = startSyntheticCaseResultSchema.parse(started.data).patientId
    const patientRes = await (await page.request.get(`${origin}/fhir/R5/Patient/${patientId}`)).json() as { id: string; meta: { versionId: string }; name: Array<{ text: string }> }
    await loginUi(page, origin, postopApp.password, 'registrar')
    const session = sessionContextSchema.parse(await (await page.request.get(`${origin}/api/auth/context`)).json())
    const registered = inpatientCommandResponseSchema.parse(await (await postInput('/api/his/v1/inpatient/admissions', {
      admissionRoute: 'direct',
      depositFen: 200000,
      expectedEpoch: session.actor.epoch,
      patientId: patientRes.id,
      patientVersion: patientRes.meta.versionId,
      wardId: 'ward-general',
    })).json()).data.admission
    await loginUi(page, origin, postopApp.password, 'ward-nurse')
    const admission = inpatientCommandResponseSchema.parse(await (await postInput(`/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
      bedId,
      encounterVersion: registered.versionId,
    })).json()).data.admission
    return { admission, patientName: patientRes.name[0]!.text, path: `/api/his/v1/inpatient/admissions/${admission.id}` }
  }

  // ==================== 旅程 1：普外全麻手术（stop-on-completion） ====================
  const generalStay = await admitSyntheticPatient('bed-general-1')
  await loginUi(page, origin, postopApp.password, 'inpatient-doctor')
  const clinicalCatalog = inpatientFullCatalogSchema.parse(await (await page.request.get(`${origin}/api/his/v1/inpatient/clinical-catalog`)).json())
  const amlodipine = clinicalCatalog.medications.find(item => item.id === 'medication-amlodipine')!
  const metoprolol = clinicalCatalog.medications.find(item => item.display.includes('美托洛尔'))!
  let encVersion = inpatientFullClinicalResponseSchema.parse(await (await postInput(`${generalStay.path}/diagnoses/confirm`, {
    encounterVersion: generalStay.admission.versionId,
    entries: [
      { admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:K80.200', role: 'primary' },
      { admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'secondary' },
    ],
    expectedRevision: 0,
  })).json()).data.encounterVersion

  // 开立术前长期药嘱（氨氯地平）与术前临时药嘱（美托洛尔 ONCE）
  const preopLong = inpatientFullClinicalResponseSchema.parse(await (await postInput(`${generalStay.path}/orders/issue`, {
    duration: 'long',
    encounterVersion: encVersion,
    selection: { catalogItemId: amlodipine.id, catalogVersion: amlodipine.version, doseQuantity: 1, doseText: '5 mg', frequencyCode: 'QD', kind: 'medication', routeCode: 'PO' },
  })).json()).data
  encVersion = preopLong.encounterVersion
  const longOrder = preopLong.orders.at(-1)!
  const preopTemp = inpatientFullClinicalResponseSchema.parse(await (await postInput(`${generalStay.path}/orders/issue`, {
    duration: 'temporary',
    encounterVersion: encVersion,
    selection: { catalogItemId: metoprolol.id, catalogVersion: metoprolol.version, doseQuantity: 1, doseText: '47.5 mg', frequencyCode: 'ONCE', kind: 'medication', routeCode: 'PO' },
  })).json()).data
  const tempOrder = preopTemp.orders.at(-1)!

  await loginUi(page, origin, postopApp.password, 'ward-nurse')
  expect((await postInput(`${generalStay.path}/vital-signs`, {
    bloodPressure: { diastolicMmHg: 78, systolicMmHg: 130 },
    encounterVersion: preopTemp.encounterVersion,
    expectedRevision: 0,
    oxygenSaturationPct: 99,
    pulseBpm: 76,
    respirationBpm: 18,
    temperatureC: 36.6,
    weightKg: 66,
  })).status()).toBe(200)
  expect((await postInput(`${generalStay.path}/orders/verify`, { expectedOrderVersion: longOrder.version, orderId: longOrder.id })).status()).toBe(200)
  expect((await postInput(`${generalStay.path}/orders/verify`, { expectedOrderVersion: tempOrder.version, orderId: tempOrder.id })).status()).toBe(200)

  // 医生在真实浏览器中申请 51.2300 腹腔镜胆囊切除术，验证自动推荐 stop-on-completion 策略
  await loginUi(page, origin, postopApp.password, 'inpatient-doctor')
  await page.getByRole('button', { name: new RegExp(generalStay.patientName) }).click()
  await selectInpatientStage(page, '手术')
  await page.getByRole('button', { name: '申请手术', exact: true }).first().click()
  const reqDialog = page.getByRole('dialog', { name: '申请手术', exact: true })
  await reqDialog.getByLabel('计划术式', { exact: true }).click()
  await page.getByRole('option', { name: /51\.2300 · 腹腔镜下胆囊切除术/ }).click()
  await expect(reqDialog.getByLabel('术前长期医嘱停续策略', { exact: true })).toContainText('术后自动停术前长期医嘱并重整（外科/全麻）')
  await reqDialog.getByLabel('计划手术时间', { exact: true }).fill('2026-08-25T09:00')
  await reqDialog.getByLabel('手术申请理由', { exact: true }).fill('胆囊结石拟行腹腔镜下胆囊切除术')
  await reqDialog.getByRole('button', { name: '提交手术申请', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前手术计划', exact: true })).toContainText('术后自动停术前长期医嘱并重整（外科/全麻）')

  // 确认同意书 -> 护士术前核对 -> 医生开始手术 -> 完术核实预览展示自动停嘱清单 -> 确认完成
  await page.getByRole('button', { name: '确认已签', exact: true }).click()
  const consentDialog = page.getByRole('dialog', { name: '手术知情同意书', exact: true })
  await consentDialog.getByRole('button', { name: '确认手术知情同意书已签', exact: true }).click()

  await loginUi(page, origin, postopApp.password, 'ward-nurse')
  await page.getByRole('button', { name: new RegExp(generalStay.patientName) }).click()
  await selectInpatientStage(page, '手术')
  await page.getByLabel('术前核对说明', { exact: true }).fill('术前核对完成')
  await page.getByRole('button', { name: '术前核对', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前手术计划', exact: true })).toContainText('已就绪')

  await loginUi(page, origin, postopApp.password, 'inpatient-doctor')
  await page.getByRole('button', { name: new RegExp(generalStay.patientName) }).click()
  await selectInpatientStage(page, '手术')
  await page.getByRole('button', { name: '开始手术', exact: true }).click()
  await page.getByRole('dialog', { name: '开始手术', exact: true }).getByRole('button', { name: '开始手术', exact: true }).click()
  await page.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  const compDialog = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  await expect(compDialog.getByRole('region', { name: '将自动转入待停嘱的术前长期医嘱', exact: true })).toContainText('以下 1 条术前长期医嘱转为「待停嘱核对」')
  await expect(compDialog.getByRole('region', { name: '将自动转入待停嘱的术前长期医嘱', exact: true })).toContainText('氨氯地平')
  await compDialog.getByRole('button', { name: '确认完成手术', exact: true }).click()

  // 完术后顶部引导条立即提示「开立术后医嘱」，点击直达统一术后重整编排器
  const guidance = page.getByRole('region', { name: '手术完成术后医嘱引导', exact: true })
  await expect(guidance).toContainText('术前长期医嘱已按策略转入待停嘱，请立即开立术后医嘱重整')
  await guidance.getByRole('button', { name: '开立术后医嘱', exact: true }).click()
  const postopDialog = page.getByRole('dialog', { name: '开立术后医嘱（重整与复查）', exact: true })
  await expect(postopDialog).toContainText('腹腔镜下胆囊切除术')
  await expect(postopDialog).toContainText('术后自动停术前长期医嘱并重整（外科/全麻）')
  await expect(postopDialog).toContainText('EDTA-K2 紫头管')
  await expect(postopDialog).toContainText('促凝黄头管')
  await postopDialog.getByRole('button', { name: /^提交术后医嘱与检查（\d+）$/ }).click()
  await expect(postopDialog.getByText(/已成功开立术后医嘱与检查/)).toBeVisible()
  await postopDialog.getByRole('button', { name: '关闭', exact: true }).click()

  // 校验诊断医嘱页：术前长嘱为待停嘱核对、术前临嘱仍已校对、术后新医嘱带「术后医嘱 · 腹腔镜下胆囊切除术」
  await selectInpatientStage(page, '诊断医嘱')
  await expect(page.locator('article').filter({ hasText: '氨氯地平' }).filter({ hasText: '待停嘱核对' })).toBeVisible()
  await expect(page.locator('article').filter({ hasText: '美托洛尔' }).filter({ hasText: '已校对' })).toBeVisible()
  await expect(page.getByText('术后医嘱 · 腹腔镜下胆囊切除术', { exact: true }).first()).toBeVisible()

  // 校验检查检验页：术后检验带「术后复查 · 腹腔镜下胆囊切除术」
  await selectInpatientStage(page, '检查检验')
  await expect(page.getByText('术后复查 · 腹腔镜下胆囊切除术', { exact: true }).first()).toBeVisible()

  // 病区护士核停术前长嘱、校对术后新医嘱并按采血管合管集中送检
  await loginUi(page, origin, postopApp.password, 'ward-nurse')
  await page.getByRole('button', { name: new RegExp(generalStay.patientName) }).click()
  await selectInpatientStage(page, '诊断医嘱')
  await expect(page.locator('article').filter({ hasText: '氨氯地平' }).filter({ hasText: '待停嘱核对' })).toBeVisible()
  await page.getByRole('checkbox', { name: /^选择核停：.*氨氯地平/ }).check()
  await page.getByRole('button', { name: '集中核对停嘱 (1)', exact: true }).click()
  const verifyStopDialog = page.getByRole('dialog', { name: '集中核对停嘱', exact: true })
  await verifyStopDialog.getByRole('button', { name: /^确认.*1 条/ }).click()
  await expect(page.locator('article').filter({ hasText: '氨氯地平' }).filter({ hasText: '已停止' })).toBeVisible()

  await page.getByRole('button', { name: '全选当前页可校对医嘱', exact: true }).click()
  await page.getByRole('button', { name: /^集中核对新医嘱 \(\d+\)$/ }).click()
  const verifyOrderDialog = page.getByRole('dialog', { name: '集中核对新医嘱', exact: true })
  await verifyOrderDialog.getByRole('button', { name: /^确认校对 \d+ 条新医嘱$/ }).click()
  await expect(page.locator('article').filter({ hasText: '术后持续心电监护' }).filter({ hasText: '已校对' })).toBeVisible()

  await selectInpatientStage(page, '检查检验')
  await expect(page.getByText('术后复查 · 腹腔镜下胆囊切除术', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/促凝黄头管/).first()).toBeVisible()
  await expect(page.getByText('1 管 · 合并 2 项', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '全选本页可送检申请', exact: true }).click()
  await page.getByRole('button', { name: '集中送检', exact: true }).click()
  const sendDialog = page.getByRole('dialog', { name: '集中送检核对', exact: true })
  await expect(sendDialog).toContainText('共 2 管采血（合并 3 项检验）')
  await sendDialog.getByRole('button', { name: '确认送检', exact: true }).click()
  await expect(page.getByRole('region', { name: '送检逐项结果', exact: true })).toContainText('成功')

  // ==================== 旅程 2：PCI 冠脉介入（continue-active + 跳过已在用 + 禁忌剔除） ====================
  await loginUi(page, origin, postopApp.password, 'admin')
  const pciStay = await admitSyntheticPatient('bed-general-2')
  await loginUi(page, origin, postopApp.password, 'inpatient-doctor')
  const aspirin = clinicalCatalog.medications.find(item => item.display.includes('阿司匹林'))!
  let pciEncVer = inpatientFullClinicalResponseSchema.parse(await (await postInput(`${pciStay.path}/diagnoses/confirm`, {
    encounterVersion: pciStay.admission.versionId,
    entries: [
      { admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'primary' },
      { admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'secondary' },
    ],
    expectedRevision: 0,
  })).json()).data.encounterVersion
  const aspRes = inpatientFullClinicalResponseSchema.parse(await (await postInput(`${pciStay.path}/orders/issue`, {
    duration: 'long',
    encounterVersion: pciEncVer,
    selection: { catalogItemId: aspirin.id, catalogVersion: aspirin.version, doseQuantity: 1, doseText: '100 mg', frequencyCode: 'QD', kind: 'medication', routeCode: 'PO' },
  })).json()).data
  pciEncVer = aspRes.encounterVersion
  const aspOrder = aspRes.orders.at(-1)!

  await loginUi(page, origin, postopApp.password, 'ward-nurse')
  expect((await postInput(`${pciStay.path}/vital-signs`, {
    bloodPressure: { diastolicMmHg: 78, systolicMmHg: 126 },
    encounterVersion: pciEncVer,
    expectedRevision: 0,
    oxygenSaturationPct: 99,
    pulseBpm: 46, // 心率 < 50 触发 β 受体阻滞剂禁忌剔除
    respirationBpm: 18,
    temperatureC: 36.5,
    weightKg: 70,
  })).status()).toBe(200)
  expect((await postInput(`${pciStay.path}/orders/verify`, { expectedOrderVersion: aspOrder.version, orderId: aspOrder.id })).status()).toBe(200)

  // 申请 88.5500 冠脉造影（无 PCI 术前选型强制前置，默认推荐 continue-active），整台完术后打开术后重整编排器
  await loginUi(page, origin, postopApp.password, 'inpatient-doctor')
  await page.getByRole('button', { name: new RegExp(pciStay.patientName) }).click()
  await selectInpatientStage(page, '手术')
  await page.getByRole('button', { name: '申请手术', exact: true }).first().click()
  const pciReqDialog = page.getByRole('dialog', { name: '申请手术', exact: true })
  await pciReqDialog.getByLabel('计划术式', { exact: true }).click()
  await page.getByRole('option', { name: /88\.5500/ }).click()
  await expect(pciReqDialog.getByLabel('术前长期医嘱停续策略', { exact: true })).toContainText('继续术前有效长期医嘱（常规介入/局麻）')
  await pciReqDialog.getByLabel('计划手术时间', { exact: true }).fill('2026-08-25T10:30')
  await pciReqDialog.getByLabel('手术申请理由', { exact: true }).fill('冠心病拟行冠状动脉造影评估')
  await pciReqDialog.getByRole('button', { name: '提交手术申请', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前手术计划', exact: true })).toContainText('继续术前有效长期医嘱（常规介入/局麻）')

  const pciReqDraft = inpatientSurgerySchema.parse(await (await page.request.get(`${origin}${pciStay.path}/surgeries`)).json()).requests[0]!
  expect((await postInput(`${pciStay.path}/surgeries/confirm-consent`, {
    expectedDiagnosisRevision: 1,
    expectedRequestVersion: pciReqDraft.version,
    patientChoice: 'agree',
    requestId: pciReqDraft.id,
    signerName: pciStay.patientName,
    signerRole: 'patient',
  })).status()).toBe(200)

  await loginUi(page, origin, postopApp.password, 'ward-nurse')
  const pciReq = inpatientSurgerySchema.parse(await (await page.request.get(`${origin}${pciStay.path}/surgeries`)).json()).requests[0]!
  expect((await postInput(`${pciStay.path}/surgeries/check-preop`, { expectedRequestVersion: pciReq.version, note: '造影术前核对完成', requestId: pciReq.id })).status()).toBe(200)

  await loginUi(page, origin, postopApp.password, 'inpatient-doctor')
  const readyPciReq = inpatientSurgerySchema.parse(await (await page.request.get(`${origin}${pciStay.path}/surgeries`)).json()).requests[0]!
  expect((await postInput(`${pciStay.path}/surgeries/execute`, {
    catalogVersion: readyPciReq.plannedProcedure.version,
    expectedRequestVersion: readyPciReq.version,
    materials: [],
    procedureId: readyPciReq.plannedProcedure.id,
    requestId: readyPciReq.id,
  })).status()).toBe(200)

  await page.getByRole('button', { name: new RegExp(pciStay.patientName) }).click()
  await selectInpatientStage(page, '手术')
  const pciGuidance = page.getByRole('region', { name: '手术完成术后医嘱引导', exact: true })
  await expect(pciGuidance).toContainText('手术已完成，可一键套用术后成套医嘱模板补充术后医嘱与复查')
  await pciGuidance.getByRole('button', { name: '开立术后医嘱', exact: true }).click()
  const pciPostopDialog = page.getByRole('dialog', { name: '开立术后医嘱（重整与复查）', exact: true })
  await expect(pciPostopDialog).toContainText('继续术前有效长期医嘱（常规介入/局麻）')
  await expect(pciPostopDialog.getByRole('heading', { name: /术前已在用 · 默认跳过/ })).toBeVisible()
  await expect(pciPostopDialog).toContainText('阿司匹林')
  await expect(pciPostopDialog.getByRole('heading', { name: /已按禁忌剔除/ })).toBeVisible()
  await expect(pciPostopDialog).toContainText('β 受体阻滞剂')
  await pciPostopDialog.getByRole('button', { name: /^提交术后医嘱与检查（\d+）$/ }).click()
  await expect(pciPostopDialog.getByText(/已成功开立术后医嘱与检查/)).toBeVisible()
  await pciPostopDialog.getByRole('button', { name: '关闭', exact: true }).click()

  // 确认术前阿司匹林长嘱保持在执状态（未被自动停嘱），且新开立术后医嘱已关联本次手术
  await selectInpatientStage(page, '诊断医嘱')
  await expect(page.locator('article').filter({ hasText: '阿司匹林' }).filter({ hasText: '已校对' })).toBeVisible()
  await expect(page.getByText(/术后医嘱 · .*冠状动脉造影术/).first()).toBeVisible()
})
