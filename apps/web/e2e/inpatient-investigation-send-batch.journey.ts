import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { createPatientResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { z } from 'zod'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { sourceArtifactHash } from '../../server/src/application/scenario-data/provider.ts'
import { runReferenceDatabaseCli } from '../../server/src/reference-database-cli.ts'
import { expect } from './fixtures.ts'
import { openQueue } from './queue-overlay.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

async function createSendReferenceDatabase(directory: string, longNames: boolean) {
  const sourceVersion = '2026-09-01', system = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
  const tests = [
    { code: '0100101A', display: '合成白细胞计数', loinc: '6690-2', low: 3.5, high: 9.5, unitCode: '10*9/L', unitDisplay: '×10^9/L' },
    { code: '0100501A', display: '合成血红蛋白', loinc: '718-7', low: 115, high: 150, unitCode: 'g/L', unitDisplay: 'g/L' },
    { code: '0100301A', display: '合成血小板计数', loinc: '777-3', low: 125, high: 350, unitCode: '10*9/L', unitDisplay: '×10^9/L' },
  ]
  if (longNames) for (const item of tests) item.display += '（合成长中文名称：护士逐项核对本次住院申请及冻结全血标本，送检后仍须由检验岗位受理并实际执行）'.repeat(3)
  const panelDisplay = longNames ? '合成血常规（合成长中文组合申请：白细胞、血红蛋白与血小板分别保留原来源和冻结标本，送检不会立即生成报告）'.repeat(3) : '合成血常规'
  const panelConceptId = 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC'
  const artifact = `${JSON.stringify({ schemaVersion: '1', medicationProducts: [], concepts: [...tests.map(item => ({
    code: item.code, display: item.display, domain: 'laboratory', id: `wst-886:2026:${item.code}`,
    sourceLocator: `synthetic:send-e2e:${item.code}`, status: 'active', system, version: '2026',
  })), { code: 'CN-LAB-CBC', display: panelDisplay, domain: 'laboratory', id: panelConceptId,
    sourceLocator: 'synthetic:send-e2e:CN-LAB-CBC', status: 'active',
    system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn', version: sourceVersion }],
  laboratoryDefinitions: [...tests.map(item => ({ adultReferenceRules: [{ high: item.high, low: item.low, notes: '合成成人静脉血定义',
    referenceKind: 'range', sex: 'all', simulationHigh: item.high, simulationLow: item.low, sourceLocation: '合成测试定义',
    sourceStandard: 'WS/T 405-2012', sourceType: 'national-standard', sourceVersion: '2012' }],
    alternateCodings: [{ code: item.loinc, system: 'http://loinc.org', version: '2.83' }], analyte: item.display, category: '血细胞分析',
    conceptId: `wst-886:2026:${item.code}`, datasetReleaseId: `laboratory-cn@${sourceVersion}.r1`, healthyStrategy: 'uniform',
    kind: 'laboratory-cn-test', precision: 1, resultKind: 'quantity', scale: '定量', sourceLocator: `synthetic:send-e2e:${item.code}`,
    sourceVersion, specimen: '全血', unit: { code: item.unitCode, display: item.unitDisplay, system: 'http://unitsofmeasure.org' },
  })), { conceptId: panelConceptId, datasetReleaseId: `laboratory-cn@${sourceVersion}.r1`, kind: 'laboratory-cn-panel',
    notes: '合成白细胞、血红蛋白和血小板组合', sourceLocation: 'synthetic/send-batch/panel', sourceLocator: 'synthetic:send-e2e:CN-LAB-CBC',
    sourceType: 'project-authored', sourceVersion, specimen: '全血' }],
  laboratoryPanelMembers: tests.map((item, index) => ({ memberConceptId: `wst-886:2026:${item.code}`, memberOrder: index + 1,
    panelConceptId, relationship: 'contains', sourceLocator: `synthetic:send-e2e:CN-LAB-CBC:${index + 1}` })) })}\n`
  await writeFile(join(directory, 'reference.json'), artifact)
  const manifestPath = join(directory, 'release.json')
  await writeFile(manifestPath, `${JSON.stringify({ createdAt: '2026-09-01T07:00:00.000Z', releaseId: 'send-batch-e2e-v1', schemaVersion: '1',
    sources: [{ acquisitionMethod: 'generated', artifactPath: 'reference.json', checksum: createHash('sha256').update(artifact).digest('hex'),
      licenseId: 'LicenseRef-Synthetic-Test', retrievedAt: '2026-09-01T07:00:00.000Z', sourceId: 'synthetic-send-laboratory-cn',
      sourceUrl: 'https://example.test/synthetic-send-laboratory-cn', upstreamVersion: sourceVersion }] })}\n`)
  const databasePath = join(directory, 'reference.sqlite')
  await runReferenceDatabaseCli(['migrate', '--database', databasePath])
  await runReferenceDatabaseCli(['import', '--database', databasePath, '--manifest', manifestPath])
  return databasePath
}

/** Web、Surface 和原生录屏共用受支持合成来源，不加载影像素材。 */
export async function createInvestigationSendBatchApp(webRoot: string, options: { longNames?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-send-batch-e2e-'))
  try {
    const referenceDatabasePath = await createSendReferenceDatabase(directory, options.longNames === true)
    const app = await startBrowserServer(webRoot, { referenceDatabasePath, activeReferenceReleaseId: 'send-batch-e2e-v1',
      patientPersonaModel: 'synthetic-persona', syntheaProvider: new class extends StubSyntheaProvider {
        override async generate() {
          const corpus = await super.generate()
          return { ...corpus, sources: corpus.sources.map(source => {
            const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(source.raw)
            raw.entry.find(entry => entry.resource.id === 'iwtest')!.resource.valueQuantity = { value: 11.2, code: '10*9/L', unit: '10*9/L', system: 'http://unitsofmeasure.org' }
            raw.entry.find(entry => entry.resource.id === 'ihtest')!.resource.valueQuantity = { value: 135, code: 'g/L', unit: 'g/L', system: 'http://unitsofmeasure.org' }
            raw.entry.find(entry => entry.resource.id === 'iptest')!.resource.valueQuantity = { value: 210, code: '10*9/L', unit: '10*9/L', system: 'http://unitsofmeasure.org' }
            return { ...source, raw, hash: sourceArtifactHash(raw) }
          }) }
        }
      }(), chatCompletionsProvider: { completeJson: async input => ({ model: input.model, content: JSON.stringify(persona) }) } })
    return { ...app, close: async () => { try { await app.close() } finally { await rm(directory, { recursive: true, force: true }) } } }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}

/** 只准备已有单项申请；本票送检全部通过护士工作区办理。 */
export async function prepareInvestigationSendBatchPatient(page: Page, app: Awaited<ReturnType<typeof createInvestigationSendBatchApp>>) {
  const source = await startConsultationCase(app.runtime, app.password, app.origin)
  const login = async (role: string) => expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: app.password },
  })).status()).toBe(200)
  const get = (path: string) => page.request.get(app.origin + path)
  const post = (path: string, input: unknown, patient = false) => page.request.post(app.origin + path, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input, ...(patient ? { expectedVersions: {} } : {}) },
  })
  const register = async (patient: { id: string; version: string }, bedId: string) => {
    const session = sessionContextSchema.parse(await (await get('/api/auth/context')).json())
    const response = await post('/api/his/v1/inpatient/admissions', { expectedEpoch: session.actor.epoch, patientId: patient.id,
      patientVersion: patient.version, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 })
    expect(response.status()).toBe(200)
    const admission = inpatientCommandResponseSchema.parse(await response.json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    await login('ward-nurse')
    expect((await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId })).status()).toBe(200)
    return { name: admission.patientName, admissionId: admission.id, path }
  }
  await login('registrar')
  const encounter = fhirResourceSchema.parse(await (await get(`/fhir/R5/Encounter/${source.encounterId}`)).json())
  const reference = z.object({ reference: z.string() }).parse(encounter.subject).reference
  const patient = fhirResourceSchema.parse(await (await get(`/fhir/R5/${reference}`)).json())
  const s = await register({ id: patient.id!, version: patient.meta!.versionId! }, 'bed-general-1')
  const read = async () => inpatientInvestigationsSchema.parse(await (await get(`${s.path}/investigations`)).json())
  await login('inpatient-doctor')
  const catalog = inpatientInvestigationCatalogSchema.parse(await (await get('/api/his/v1/inpatient/investigation-catalog')).json())
  const issue = async (display: string) => {
    const selected = catalog.items.find(item => item.kind === 'laboratory' && item.display.startsWith(display))!
    const before = await read()
    const clinical = inpatientFullClinicalSchema.parse(await (await get(`${s.path}/clinical`)).json())
    const response = await post(`${s.path}/investigations/issue`, { encounterVersion: clinical.encounterVersion, catalogVersion: selected.version,
      selection: { kind: 'laboratory', catalogItemId: selected.id, indicationCode: selected.indicationCodes[0] } })
    expect(response.status(), response.ok() ? undefined : await response.text()).toBe(200)
    return inpatientInvestigationResponseSchema.parse(await response.json()).data.laboratoryRequests.find(item => !before.laboratoryRequests.some(old => old.id === item.id))!
  }
  const requests = []
  for (const display of ['合成白细胞计数', '合成血红蛋白', '合成血常规']) requests.push(await issue(display))
  await login('registrar')
  const otherPatient = createPatientResponseSchema.parse(await (await post('/api/his/v1/patients', {
    name: '合成送检范围隔离患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
  }, true)).json()).data.patient
  const other = await register({ id: otherPatient.id, version: otherPatient.versionId }, 'bed-general-2')
  await login('ward-nurse')
  const baseline = await read()
  expect(baseline.sent).toEqual([])
  expect(baseline.laboratoryRequests).toHaveLength(3)
  return { ...s, app, other, requests, baseline, issue, api: { login, get, post } }
}

type Patient = Awaited<ReturnType<typeof prepareInvestigationSendBatchPatient>>
type Step = (caption: string) => Promise<void>

export async function openInvestigationSendBatchPatient(page: Page, s: Patient, open: () => Promise<void>) {
  await open()
  await expect(page.getByRole('region', { name: '住院工作台', exact: true })).toBeVisible()
  // Surface 的容器宽度可小于 viewport；以真实队列入口为准。
  const toggle = page.getByRole('button', { name: '展开队列', exact: true })
  if (await toggle.isVisible()) await toggle.click()
  await page.getByRole('button', { name: new RegExp(s.name) }).click()
  await selectInpatientStage(page, '检查检验')
}

/** 同一真实岗位闭环用于 Web、双 React ShadowRoot 和最终 SHA 原生录屏。 */
export async function runInvestigationSendBatchJourney(page: Page, s: Patient, open: () => Promise<void>, step: Step = async () => {}) {
  const get = (path: string) => page.request.get(s.app.origin + path)
  await openInvestigationSendBatchPatient(page, s, open)
  const choices = page.getByRole('checkbox', { name: /^选择送检：/ })
  await expect(choices).toHaveCount(3)
  await expect(page.getByRole('button', { name: '校对并送检', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '全选本页可送检申请', exact: true }).click()
  const drafts = page.getByRole('region', { name: '送检待处理清单', exact: true })
  await expect(drafts).toContainText(/已选\s*3\s*项/)
  await expect(drafts).toContainText('全血')
  await page.getByRole('button', { name: '清空选择', exact: true }).click()
  for (const choice of await choices.all()) await expect(choice).not.toBeChecked()
  await expect(drafts).toContainText('合成血红蛋白')
  await page.getByRole('button', { name: '全选本页可送检申请', exact: true }).click()
  await step('病区护士选择三项待送检申请，核对名称、类别、全血标本与当前状态')
  await openQueue(page)
  await page.getByRole('button', { name: new RegExp(s.other.name) }).click()
  await expect(choices).toHaveCount(0)
  await openInvestigationSendBatchPatient(page, s, async () => {})
  await expect(drafts).toContainText(/已选\s*3\s*项/)
  await page.reload()
  await openInvestigationSendBatchPatient(page, s, async () => {})
  await expect(drafts).toContainText(/已选\s*3\s*项/)
  for (const choice of await choices.all()) await expect(choice).toBeChecked()
  await step('清空勾选保留草稿，切患者和刷新恢复三项选择，尚未产生送检事实')

  const keys: string[] = [], sentIds: string[] = []
  await page.route(`**${s.path}/investigations/send`, async route => {
    keys.push(route.request().headers()['idempotency-key']!)
    sentIds.push(route.request().postDataJSON().input.requestId)
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientInvestigationResponseSchema.parse(await response.json())
    if (keys.length === 2) await route.abort('failed'); else await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '集中送检', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '集中送检核对', exact: true })
  await expect(dialog.getByRole('article')).toHaveCount(3)
  await expect(dialog).toContainText('全血')
  await expect(dialog).toContainText('待送检')
  await expect(dialog).toContainText('临床评估')
  await expect(dialog).not.toContainText('clinical-evaluation')
  await step('集中核对三项申请的名称、标本和待送检状态，再一次确认')
  await dialog.getByRole('button', { name: '确认送检', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原送检', exact: true })).toBeEnabled()
  expect(keys).toHaveLength(2)
  expect(new Set(keys).size).toBe(2)
  const partial = inpatientInvestigationsSchema.parse(await (await get(`${s.path}/investigations`)).json())
  expect(partial.sent.map(item => item.requestId).sort()).toEqual([...sentIds].sort())
  expect(partial.laboratoryRequests.every(item => item.status === 'issued' && item.report === undefined)).toBe(true)
  await expect(page.getByRole('region', { name: '送检逐项结果', exact: true })).toContainText('成功')
  await step('第一项成功、第二项响应丢失，第三项停止发送；逐项结果保留原尝试')
  await page.reload()
  await openInvestigationSendBatchPatient(page, s, async () => {})
  const receiptRequest = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原送检', exact: true }).click()
  expect(new URL((await receiptRequest).url()).searchParams.get('idempotencyKey')).toBe(keys[1])
  await expect(page.getByRole('button', { name: '恢复原送检', exact: true })).toHaveCount(0)
  expect(keys).toHaveLength(2)
  const recovered = inpatientInvestigationsSchema.parse(await (await get(`${s.path}/investigations`)).json())
  expect(recovered.sent).toHaveLength(2)
  const receipt = commandReceiptLookupSchema.parse(await (await get(`/api/his/v1/command-receipts?operationId=inpatient.investigation.send&idempotencyKey=${keys[1]}`)).json())
  expect(receipt.status).toBe('completed')
  await step('按原幂等键恢复送检回执，两项已送检；第三项保留，重新核对后才继续')
  await page.getByRole('button', { name: '集中送检', exact: true }).click()
  await expect(dialog.getByRole('article')).toHaveCount(1)
  await dialog.getByRole('button', { name: '确认送检', exact: true }).click()
  await expect.poll(async () => inpatientInvestigationsSchema.parse(await (await get(`${s.path}/investigations`)).json()).sent.length).toBe(3)
  expect(keys).toHaveLength(3)
  expect(new Set(keys).size).toBe(3)
  expect(new Set(sentIds).size).toBe(3)
  const final = inpatientInvestigationsSchema.parse(await (await get(`${s.path}/investigations`)).json())
  expect(final.laboratoryRequests.every(item => item.status === 'issued' && item.report === undefined)).toBe(true)
  expect(final.laboratoryRequests.map(item => [item.id, item.version]).sort()).toEqual(s.baseline.laboratoryRequests.map(item => [item.id, item.version]).sort())
  const clinical = inpatientFullClinicalSchema.parse(await (await get(`${s.path}/clinical`)).json())
  expect(clinical.charges).toEqual([])
  expect(final.sent.every(item => item.sentAt.length > 0 && item.sentBy.length > 0)).toBe(true)
  await expect(page.getByRole('region', { name: '送检逐项结果', exact: true })).toContainText('成功')
  await step('三项分别送检成功且不重复，保留送检时间与人员；尚未受理、出报告或收费')
  return { posts: keys.length, keys, sentIds, sent: final.sent.length, reports: 0, charges: clinical.charges.length }
}
