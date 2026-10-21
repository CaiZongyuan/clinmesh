import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import { doctorCaseDetailSchema, type DoctorCaseDetail } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase } from '../../server/tests/fixtures/consultation.ts'
import { syntheticGuidelineDocument, syntheticGuidelineMarker, syntheticGuidelineParagraph } from '../../server/tests/fixtures/guideline-corpus.ts'
import { test as base } from './fixtures.ts'
import { createRecommendationGuidelineDatabase, recommendationFixture, RecommendationSyntheaProvider,
  recommendationProcessingMarker, recommendationReasoningMarker } from './doctor-recommendations-fixture.ts'
import { createInvestigationReferenceDatabase } from './investigation-workspace.fixture.ts'

const test = base.extend<{ recommendationCase: Awaited<ReturnType<typeof startConsultationCase>> }>({
  browserApp: async ({ webRoot }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-recommendation-e2e-'))
    try {
      const referenceDatabasePath = await createInvestigationReferenceDatabase(directory)
      const app = await startBrowserServer(webRoot, {
        activeReferenceReleaseId: 'investigation-e2e-v1', referenceDatabasePath,
        guidelineDatabasePath: createRecommendationGuidelineDatabase(directory),
        patientPersonaModel: 'synthetic-persona', syntheaProvider: new RecommendationSyntheaProvider(), autoDispatchIntervalMs: 30,
        chatCompletionsProvider: { completeJson: async input => ({ model: input.model,
          content: JSON.stringify(input.schemaName === 'patient_persona' ? persona : recommendationFixture(input)) }) },
      })
      try { await use(app) }
      finally { await app.close() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  },
  recommendationCase: async ({ browserApp }, use) => {
    await use(await startConsultationCase(browserApp.runtime, browserApp.password, browserApp.origin))
  },
})

// 原 doctor-recommendations-journey.ts 的旅程按本文件迁移：仅「填写处方」行内草稿断言换成弹窗合同下的草稿卡片断言。
async function runRecommendationJourney({ page, read }: { page: Page; read: () => Promise<DoctorCaseDetail> }) {
  const details = page.getByRole('dialog', { name: '依据与说明', exact: true })
  const closeDetails = async () => {
    await details.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(details).toHaveCount(0)
  }
  // Preparation runs while the doctor remains in the consultation; no summary block is added.
  await expect(page.getByText('问诊阶段的三类待办已按最新资料核对', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '暂停自动准备', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: /待确认诊断|待开具处方|待开具检验/ })).toHaveCount(0)
  await page.getByRole('tab', { name: '病历记录', exact: true }).click()
  const history = page.getByLabel('现病史', { exact: true })
  const originalHistory = await history.inputValue()
  const saveHistory = async (text: string) => {
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await history.fill(text)
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect.poll(async () => (await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(text)
  }
  await saveHistory(recommendationReasoningMarker)
  for (const target of [
    { tab: '诊断', panel: '待确认诊断' }, { tab: '检验检查', panel: '待开具检验' },
  ]) {
    await page.getByRole('tab', { name: target.tab, exact: true }).click()
    const panel = page.getByRole('region', { name: target.panel, exact: true })
    await expect(panel.getByText('暂无可直接确认或开具的项目。', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '待核实思路', exact: true })).toHaveCount(0)
    await panel.getByRole('button', { name: '依据与说明', exact: true }).click()
    const thoughts = details.getByRole('region', { name: '待核实思路', exact: true })
    await expect(thoughts.getByRole('article')).toHaveCount(2)
    const direct = thoughts.getByRole('article', { name: '合成体位相关头晕的评估思路', exact: true })
    await expect(direct.getByText(recommendationReasoningMarker, { exact: true })).toBeVisible()
    await expect(direct.getByText('询问起立时是否加重，以决定是否进行卧立位血压评估。', { exact: true })).toBeVisible()
    await expect(thoughts.getByRole('button')).toHaveCount(0)
    await expect(thoughts.getByRole('link')).toHaveCount(0)
    await expect(details.getByText(/未通过当前指南支持核验/)).toBeVisible()
    await expect(details.getByText(/未匹配当前可执行的本院目录/)).toBeVisible()
    await expect(details.getByText(/不能改写为已排除/)).toBeVisible()
    await expect(thoughts.getByText('合成被核验拦截的确定性结论', { exact: true })).toHaveCount(0)
    await closeDetails()
    const unchanged = await read()
    expect(unchanged.diagnosis?.draft).toBeUndefined()
    expect(unchanged.diagnosis?.confirmation).toBeUndefined()
    expect(unchanged.laboratoryRequests?.draft).toBeUndefined()
    expect(unchanged.laboratoryRequests?.requests ?? []).toEqual([])
  }
  await saveHistory(recommendationProcessingMarker)
  await page.getByRole('tab', { name: '诊断', exact: true }).click()
  const diagnosis = page.getByRole('region', { name: '待确认诊断', exact: true })
  await diagnosis.getByRole('button', { name: '依据与说明', exact: true }).click()
  await expect(details.getByText(/模型本轮未形成可发布的建议或待核实思路/)).toBeVisible()
  await closeDetails()

  await saveHistory(syntheticGuidelineMarker)
  await page.getByRole('tab', { name: '诊断', exact: true }).click()
  const confirmDiagnosis = diagnosis.getByRole('button', { name: /^确认选中诊断/ })
  await expect(confirmDiagnosis).toBeEnabled()
  await expect(page.getByRole('button', { name: /^采纳 / })).toHaveCount(0)
  await expect(page.getByText(syntheticGuidelineParagraph, { exact: true })).toHaveCount(0)
  await diagnosis.getByRole('button', { name: '依据与说明', exact: true }).click()
  await expect(details.getByRole('link', { name: new RegExp(syntheticGuidelineDocument.source.title) }))
    .toHaveAttribute('href', syntheticGuidelineDocument.source.url)
  await expect(details.getByText(syntheticGuidelineParagraph, { exact: true })).toBeVisible()
  await closeDetails()
  expect((await read()).diagnosis?.draft).toBeUndefined()
  expect((await read()).diagnosis?.confirmation).toBeUndefined()

  await saveHistory(originalHistory)
  await page.getByRole('tab', { name: '诊断', exact: true }).click()
  await expect(confirmDiagnosis).toBeEnabled()
  await diagnosis.getByRole('button', { name: '依据与说明', exact: true }).click()
  await expect(details.getByText(syntheticGuidelineParagraph, { exact: true })).toHaveCount(0)
  await expect(details.getByRole('link', { name: /WS\/T 872/ })).toHaveAttribute('href', /^https:\/\/www\.nhc\.gov\.cn\//)
  await closeDetails()
  await confirmDiagnosis.click()
  await expect.poll(async () => (await read()).diagnosis?.confirmation?.entries[0]?.code).toBe('I10')
  expect((await read()).diagnosis?.confirmation?.entries[0]?.role).toBe('primary')

  await page.getByRole('tab', { name: '处方', exact: true }).click()
  const prescription = page.getByRole('region', { name: '待开具处方', exact: true })
  const issuePrescription = prescription.getByRole('button', { name: /^开具处方/ })
  await expect(prescription.getByText('用法用量待补充', { exact: true })).toBeVisible()
  await expect(issuePrescription).toBeDisabled()
  await prescription.getByRole('button', { name: '依据与说明', exact: true }).click()
  await expect(details.getByRole('link', { name: /络活喜/ })).toHaveAttribute('href', /^https:\/\/www\.viatris\.cn\//)
  await closeDetails()
  expect((await read()).medicationConclusion?.prescription).toBeUndefined()
  expect((await read()).medicationConclusion?.draft).toBeUndefined()
  await prescription.getByRole('button', { name: '调整', exact: true }).click()
  const edit = page.getByRole('dialog', { name: '调整项目', exact: true })
  await expect(edit.getByRole('textbox', { name: '每次剂量', exact: true })).toHaveValue('5 mg')
  await expect(edit.getByRole('combobox', { name: '频次', exact: true })).toContainText('每日一次')
  await expect(edit.getByRole('spinbutton', { name: '疗程（天）', exact: true })).toHaveValue('')
  await expect(edit.getByRole('spinbutton', { name: '数量', exact: true })).toHaveValue('')
  await edit.getByRole('textbox', { name: '每次剂量', exact: true }).fill('5 mg')
  await edit.getByRole('spinbutton', { name: '疗程（天）', exact: true }).fill('30')
  await edit.getByRole('spinbutton', { name: '数量', exact: true }).fill('30')
  await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
  await expect(issuePrescription).toBeEnabled()
  await prescription.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(issuePrescription).toBeEnabled()
  await prescription.getByRole('button', { name: '调整', exact: true }).click()
  await expect(edit.getByRole('textbox', { name: '每次剂量', exact: true })).toHaveValue('5 mg')
  await expect(edit.getByRole('spinbutton', { name: '疗程（天）', exact: true })).toHaveValue('30')
  await expect(edit.getByRole('spinbutton', { name: '数量', exact: true })).toHaveValue('30')
  await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
  // 弹窗合同下草稿值在入口草稿卡片呈现，且不提供独立的正式开具入口。
  const medicationEntry = page.getByRole('button', { name: /^编辑药品 / })
  await expect(medicationEntry).toContainText('5 mg · QD · 30 天 · 数量 30')
  await expect(page.getByRole('button', { name: '正式开具处方', exact: true })).toHaveCount(0)
  await expect.poll(async () => (await read()).medicationConclusion?.draft?.items).toEqual([{
    catalogItemId: 'medication-amlodipine', doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30,
  }])
  await issuePrescription.click()
  await expect.poll(async () => (await read()).medicationConclusion?.prescription?.items[0]?.catalogItemId).toBe('medication-amlodipine')
  expect((await read()).medicationConclusion?.prescription?.items[0]).toMatchObject({ doseText: '5 mg', courseDays: 30, quantity: 30 })

  await page.getByRole('tab', { name: '检验检查', exact: true }).click()
  const laboratory = page.getByRole('region', { name: '待开具检验', exact: true })
  const issueLaboratory = laboratory.getByRole('button', { name: /^开具选中项目/ })
  await expect(issueLaboratory).toBeEnabled()
  expect((await read()).laboratoryRequests?.requests ?? []).toEqual([])
  expect((await read()).laboratoryRequests?.draft).toBeUndefined()
  const beforeReport = await read()
  await issueLaboratory.click()
  await expect.poll(async () => (await read()).laboratoryRequests?.requests.length).toBe(1)
  await expect.poll(async () => (await read()).laboratoryRequests?.requests[0]?.report?.status).toBe('final')
  const afterReport = await read()
  z.object({ authoredAt: z.iso.datetime({ offset: true }) }).parse(afterReport.laboratoryRequests?.requests[0])
  expect(afterReport.diagnosis?.confirmation).toEqual(beforeReport.diagnosis?.confirmation)
  expect(afterReport.medicationConclusion?.prescription).toEqual(beforeReport.medicationConclusion?.prescription)
  await laboratory.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(laboratory.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
  expect((await read()).laboratoryRequests?.requests).toHaveLength(1)
  expect((await read()).diagnosis?.confirmation?.revisionNumber).toBe(1)
  expect((await read()).medicationConclusion?.prescription?.items).toHaveLength(1)
  return { caseReasoningViewed: true, caseReasoningNotExecutable: true, classifiedNoticesViewed: true,
    rejectedReasoningWithheld: true, importedGuidelineViewed: true, importedSourceHash: syntheticGuidelineDocument.source.sha256,
    importedGuidelineNotConfirmed: true, diagnosisConfirmed: true, prescriptionIssued: true,
    laboratoryIssued: true, missingPrescriptionFieldsPreserved: true, manualEditsPreserved: true, noDuplicateOrders: true }
}

for (const width of [1280, 390]) test(`prepares in the background and directly confirms or issues selected verified items at ${width}px`, async ({ page, browserApp, recommendationCase }) => {
  const errors: string[] = []
  const preparedKinds = new Set<string>()
  page.on('response', response => {
    const match = /recommendations\/(diagnosis|laboratory|imaging|pathology|prescription)$/.exec(new URL(response.url()).pathname)
    if (response.status() === 200 && match?.[1] !== undefined) preparedKinds.add(match[1])
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  if (width === 390) await page.getByRole('button', { name: '候诊患者', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await expect.poll(() => [...preparedKinds].sort()).toEqual(['diagnosis', 'imaging', 'laboratory', 'pathology', 'prescription'])
  await runRecommendationJourney({ page, read: async () => {
    const response = await page.request.get(`${browserApp.origin}/api/his/v1/doctor/cases/${recommendationCase.outpatientCaseId}`)
    expect(response.status()).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  } })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})
