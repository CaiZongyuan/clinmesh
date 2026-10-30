import { openWorkspaceTab } from './workspace-tabs.fixture.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { coronaryDocument, coronaryGuidelineParagraph, coronaryGuidelineTitle, coronaryHistory, coronaryReferenceRelease,
  CoronarySyntheaProvider, createCoronaryData, createCoronaryProvider, excludedCoronaryParagraph, startCoronaryCase } from '../../server/tests/fixtures/coronary-guidelines.ts'
import { test, expect } from './fixtures.ts'

test('冠心病本地PDF经真实Web依据展示、诊断和检验确认及人工补全处方', async ({ page, webRoot }) => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-coronary-web-'))
  const data = await createCoronaryData(directory)
  const { provider, seen } = createCoronaryProvider()
  const app = await startBrowserServer(webRoot, {
    activeReferenceReleaseId: coronaryReferenceRelease, referenceDatabasePath: data.referenceDatabasePath,
    guidelineDatabasePath: data.guidelineDatabasePath, guidelineLocalEvaluation: true,
    patientPersonaModel: 'synthetic-coronary', syntheaProvider: new CoronarySyntheaProvider(),
    autoDispatchIntervalMs: 30, chatCompletionsProvider: provider,
  })
  try {
    const started = await startCoronaryCase(app.runtime, app.password, app.origin)
    const read = async () => {
      const response = await page.request.get(`${app.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)
      expect(response.status()).toBe(200)
      return doctorCaseDetailSchema.parse(await response.json())
    }
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${app.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(app.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.getByRole('button', { name: /^选择病例 / }).click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    await openWorkspaceTab(page, '病历记录')
    await page.getByLabel('主诉', { exact: true }).fill(coronaryDocument.chiefComplaint)
    await page.getByLabel('现病史', { exact: true }).fill(coronaryHistory)
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect.poll(async () => (await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(coronaryHistory)

    await openWorkspaceTab(page, '诊断')
    const diagnosis = page.getByRole('region', { name: '待确认诊断', exact: true })
    const confirmDiagnosis = diagnosis.getByRole('button', { name: /^确认选中诊断/ })
    await expect(confirmDiagnosis).toBeEnabled()
    await diagnosis.getByRole('button', { name: '依据与说明', exact: true }).click()
    const details = page.getByRole('dialog', { name: '依据与说明', exact: true })
    await expect(details.getByRole('link', { name: new RegExp(coronaryGuidelineTitle) })).toHaveAttribute('href', data.sourceUrl)
    await expect(details.getByText(coronaryGuidelineParagraph, { exact: true })).toBeVisible()
    await expect(details.getByText(/PDF 物理第 1 页/)).toBeVisible()
    await expect(page.getByText(excludedCoronaryParagraph, { exact: true })).toHaveCount(0)
    await details.getByRole('button', { name: 'Close', exact: true }).click()
    expect((await read()).diagnosis?.confirmation).toBeUndefined()
    await confirmDiagnosis.click()
    await expect.poll(async () => (await read()).diagnosis?.confirmation?.entries[0]?.code).toBe('I25.103')

    await openWorkspaceTab(page, '检验检查')
    const laboratory = page.getByRole('region', { name: '待开具检验', exact: true })
    const issueLaboratory = laboratory.getByRole('button', { name: /^开具选中项目/ })
    await expect(issueLaboratory).toBeEnabled()
    await issueLaboratory.click()
    await expect.poll(async () => (await read()).laboratoryRequests?.requests[0]?.catalogItemId).toBe('hospital-lab-pci-creatinine')
    await expect.poll(async () => (await read()).laboratoryRequests?.requests[0])
      .toMatchObject({ status: 'issued', billing: { status: 'pending' } })

    await openWorkspaceTab(page, '处方')
    const prescription = page.getByRole('region', { name: '待开具处方', exact: true })
    const issuePrescription = prescription.getByRole('button', { name: /^开具处方/ })
    await expect(prescription.getByText('用法用量待补充', { exact: true })).toBeVisible()
    await expect(issuePrescription).toBeDisabled()
    expect((await read()).medicationConclusion?.prescription).toBeUndefined()
    await prescription.getByRole('button', { name: '调整', exact: true }).click()
    const edit = page.getByRole('dialog', { name: '调整项目', exact: true })
    await expect(edit.getByRole('textbox', { name: '每次剂量', exact: true })).toHaveValue('')
    await expect(edit.getByRole('spinbutton', { name: '数量', exact: true })).toHaveValue('')
    await edit.getByRole('textbox', { name: '每次剂量', exact: true }).fill('100 mg')
    await edit.getByRole('spinbutton', { name: '疗程（天）', exact: true }).fill('1')
    await edit.getByRole('spinbutton', { name: '数量', exact: true }).fill('1')
    await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
    await expect(issuePrescription).toBeEnabled()
    await issuePrescription.click()
    await expect.poll(async () => (await read()).medicationConclusion?.prescription?.items[0]?.catalogItemId).toBe('medication-pci-aspirin')
    const final = await read()
    expect(final.medicationConclusion?.prescription?.items[0]).toMatchObject({ doseText: '100 mg', frequencyCode: 'QD', courseDays: 1, quantity: 1 })
    expect(final.diagnosis?.confirmation?.entries[0]?.code).toBe('I25.103')
    expect(final.laboratoryRequests?.requests).toHaveLength(1)
    for (const kind of ['diagnosis', 'laboratory', 'prescription']) {
      for (const stage of ['generation', 'verification']) {
        expect(seen.some(call => call.kind === kind && call.stage === stage
          && call.guidelines.some(guideline => guideline.sourceHash === data.sourceHash && guideline.text === coronaryGuidelineParagraph))).toBe(true)
      }
    }
    await page.reload()
    await openWorkspaceTab(page, '处方')
    expect((await read()).medicationConclusion?.prescription).toEqual(final.medicationConclusion?.prescription)
    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})
