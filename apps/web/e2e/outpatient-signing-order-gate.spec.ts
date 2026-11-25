import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  doctorCaseDetailSchema,
  encounterCompletionPreviewSchema,
} from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { test as base, expect } from './fixtures.ts'
import { createInvestigationReferenceDatabase } from './investigation-workspace.fixture.ts'
import {
  signInitialOutpatientRecordInWorkspace,
  stubOutpatientQualityChatPayload,
} from './outpatient-order-gate.fixture.ts'
import { closeQueue, expectConsultationStarted, openQueue } from './queue-overlay.fixture.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

const test = base.extend<{ consultationCase: Awaited<ReturnType<typeof startConsultationCase>> }>({
  browserApp: async ({ webRoot }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-order-gate-e2e-'))
    try {
      const referenceDatabasePath = await createInvestigationReferenceDatabase(directory)
      const app = await startBrowserServer(webRoot, {
        activeReferenceReleaseId: 'investigation-e2e-v1',
        chatCompletionsProvider: {
          completeJson: async input => {
            const quality = stubOutpatientQualityChatPayload(input)
            if (quality !== undefined) return { content: JSON.stringify(quality), model: input.model }
            if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: input.model }
            throw new Error(`Unexpected schema: ${input.schemaName}`)
          },
        },
        patientPersonaModel: 'synthetic-persona',
        referenceDatabasePath,
        syntheaProvider: new StubSyntheaProvider(),
      })
      try {
        await use(app)
      } finally {
        await app.close()
      }
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  },
  consultationCase: async ({ browserApp }, use) => {
    await use(await startConsultationCase(browserApp.runtime, browserApp.password, browserApp.origin))
  },
})

test('前置门诊首版结构化病历正式电子签名与主诊断确认作为开单门禁，并校验签后修订草稿阻断完诊', async ({
  page,
  browserApp,
  consultationCase,
}) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route(/\/recommendations\/(diagnosis|prescription|laboratory|imaging|pathology)$/, route => route.abort('failed'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await openQueue(page)
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await expectConsultationStarted(page)
  await closeQueue(page)

  const readCase = async () => {
    const response = await page.request.get(`${browserApp.origin}/api/his/v1/doctor/cases/${consultationCase.outpatientCaseId}`)
    expect(response.status()).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  }
  const readCompletion = async () => {
    const detail = await readCase()
    const response = await page.request.get(`${browserApp.origin}/api/his/v1/encounters/${detail.encounter.id}/completion`)
    expect(response.status()).toBe(200)
    return encounterCompletionPreviewSchema.parse(await response.json())
  }

  // 1. 验证门诊医生工作台页签顺序：问诊记录 -> 病历记录 -> 诊断 -> 检验检查 -> 处方
  const tabLabels = await page
    .locator('[data-doctor-region="detail"] [role="tablist"]')
    .first()
    .getByRole('tab', { includeHidden: true })
    .evaluateAll(elements =>
      elements.map(element => ['问诊记录', '病历记录', '诊断', '检验检查', '处方'].find(label => element.textContent?.includes(label))),
    )
  expect(tabLabels).toEqual(['问诊记录', '病历记录', '诊断', '检验检查', '处方'])

  // 2. 首版病历未签署前：允许保存检验/功能检查/处方草稿，但禁用正式开立按钮并展示「去签署首版病历」跳转
  await openWorkspaceTab(page, '检验检查')
  const laboratory = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
  await laboratory.getByRole('button', { name: '添加检验', exact: true }).click()
  const labComposer = page.getByRole('dialog', { name: '选择检验项目', exact: true })
  await labComposer.getByLabel('搜索检验目录', { exact: true }).fill('白细胞')
  await labComposer.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  await labComposer.getByRole('button', { name: '选择 合成白细胞计数 0100101A', exact: true }).click()
  await labComposer.getByRole('button', { name: '加入检验', exact: true }).click()
  await labComposer.getByRole('button', { name: '关闭', exact: true }).click()
  const pendingLab = laboratory.getByRole('region', { name: '待开具检验', exact: true })
  await expect(pendingLab.getByRole('button', { name: '开具选中项目（1）', exact: true })).toBeDisabled()
  await expect(pendingLab.getByRole('button', { name: '去签署首版病历', exact: true })).toBeVisible()

  await page.getByRole('tab', { name: /^功能检查/ }).click()
  await page.getByRole('combobox', { name: '功能检查项目', exact: true }).click()
  await page.getByRole('option', { name: '常规十二导联心电图', exact: true }).click()
  await page.getByLabel('检查指征', { exact: true }).fill('合成发热伴胸闷，排查心律异常。')
  await page.getByRole('button', { name: '保存功能检查草稿', exact: true }).click()
  await expect(page.getByRole('button', { name: '开立功能检查', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '去签署首版病历', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除草稿', exact: true }).click()
  await page.getByRole('dialog', { name: '删除功能检查草稿', exact: true }).getByRole('button', { name: '确认删除草稿', exact: true }).click()

  await openWorkspaceTab(page, '处方')
  await page.getByRole('button', { name: '无需用药', exact: true }).click()
  const noMedRegion = page.getByRole('region', { name: '确认无需用药', exact: true })
  await expect(noMedRegion.getByRole('button', { name: '确认无需用药', exact: true })).toBeDisabled()
  await expect(noMedRegion.getByRole('button', { name: '去签署首版病历', exact: true })).toBeVisible()
  await page.locator('[data-agent-section="prescription"] [data-view-switch] button').first().click()
  const medicationEntry = page.locator('[data-agent-section="prescription"]').getByRole('region', { name: '填写处方', exact: true })
  const pendingPrescription = page.getByRole('region', { name: '待开具处方', exact: true })
  await medicationEntry.getByRole('button', { name: '添加药品', exact: true }).click()
  const medDialog = page.getByRole('dialog', { name: '选择药品', exact: true })
  await medDialog.getByRole('button', { name: '选择 对乙酰氨基酚片', exact: true }).click()
  await medDialog.getByRole('button', { name: '加入处方', exact: true }).click()
  await medDialog.getByRole('button', { name: '完成选择', exact: true }).click()
  await expect(medicationEntry.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await expect(pendingPrescription.getByRole('button', { name: /^开具处方/ })).toBeDisabled()
  const jumpToRecord = pendingPrescription.getByRole('button', { name: '去签署首版病历', exact: true })
  await expect(jumpToRecord).toBeVisible()
  await jumpToRecord.click()
  await expect(page.getByRole('tab', { name: '病历记录', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')

  // 3. 正式电子签署首版结构化病历后：转为「去确认诊断」门禁并支持一键跳转
  await signInitialOutpatientRecordInWorkspace(page, {
    assessment: '合成发热初步评估完成，待确认主诊断后对症处理。',
    chiefComplaint: '合成发热伴头痛一天。',
    disposition: '门诊口服退热药观察。',
    followUp: '高热持续或出现新发症状及时复诊。',
    historyOfPresentIllness: '患者一天前无明显诱因出现发热伴头痛。',
    physicalExamination: '神志清楚，双肺呼吸音清。',
  })
  await expect.poll(async () => (await readCase()).clinicalDocument?.signed.length).toBe(1)

  await openWorkspaceTab(page, '处方')
  await expect(pendingPrescription.getByRole('button', { name: /^开具处方/ })).toBeDisabled()
  await expect(pendingPrescription.getByRole('button', { name: '去签署首版病历', exact: true })).toHaveCount(0)
  const jumpToDiagnosis = pendingPrescription.getByRole('button', { name: '去确认诊断', exact: true })
  await expect(jumpToDiagnosis).toBeVisible()
  await jumpToDiagnosis.click()
  await expect(page.getByRole('tab', { name: '诊断', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')

  // 4. 确认主诊断后解锁检验检查与处方正式开立
  await page.locator('[data-agent-section="diagnosis"]').getByRole('button', { name: '添加诊断', exact: true }).click()
  const diagnosisDialog = page.getByRole('dialog', { name: '选择诊断', exact: true })
  await diagnosisDialog.getByRole('button', { name: '选择 发热，未特指 R50.9', exact: true }).click()
  await diagnosisDialog.getByRole('button', { name: '加入诊断', exact: true }).click()
  await diagnosisDialog.getByRole('button', { name: '完成选择', exact: true }).click()
  await page.getByRole('region', { name: '待确认诊断', exact: true }).getByRole('button', { name: /^确认选中诊断/ }).click()
  await expect(page.getByRole('region', { name: '诊断列表', exact: true })).toBeVisible()

  await openWorkspaceTab(page, '检验检查')
  await page.getByRole('tab', { name: /^检验 \d+$/ }).click()
  await expect(pendingLab.getByRole('button', { name: '开具选中项目（1）', exact: true })).toBeEnabled()
  await expect(pendingLab.getByRole('button', { name: '去确认诊断', exact: true })).toHaveCount(0)
  // 清空本次手动检验草稿，测试后续直接完诊门禁
  await page.getByRole('button', { name: '清空待开清单', exact: true }).click()
  await page.getByRole('alertdialog', { name: '丢弃全部手动待开检验？', exact: true }).getByRole('button', { name: '确认清空', exact: true }).click()
  await expect(pendingLab.getByRole('checkbox')).toHaveCount(0)

  await openWorkspaceTab(page, '处方')
  await expect(pendingPrescription.getByRole('button', { name: /^开具处方/ })).toBeEnabled()
  await expect(pendingPrescription.getByRole('button', { name: '去确认诊断', exact: true })).toHaveCount(0)
  await pendingPrescription.getByRole('button', { name: /^开具处方/ }).click()
  await expect(page.getByRole('region', { name: '药品列表', exact: true })).toBeVisible()
  await expect.poll(async () => (await readCompletion()).canComplete).toBe(true)

  // 5. 开方后点击「补充病历评估/处置/随访」自动写入修订草稿并展开修订表单，阻断完诊（no-pending-drafts -> clinical-document），支持放弃或再次保存修订草稿后正式修订签名完诊
  await page.getByRole('button', { name: '补充病历评估/处置/随访', exact: true }).click()
  await expect(page.getByRole('tab', { name: '病历记录', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
  const revisionForm = page.getByRole('form', { name: '修订病历版本', exact: true })
  await expect(revisionForm).toBeVisible()
  await expect(revisionForm.getByLabel('处置', { exact: true })).toContainText('已开具门诊处方')
  await expect(page.getByText('存在待签署的病历修订草稿', { exact: true })).toBeVisible()
  await expect.poll(async () => {
    const preview = await readCompletion()
    const pendingDraftItem = preview.items.find(item => item.code === 'no-pending-drafts')
    return { canComplete: preview.canComplete, status: pendingDraftItem?.status, target: pendingDraftItem?.target }
  }).toEqual({ canComplete: false, status: 'incomplete', target: 'clinical-document' })

  const discardCaseRefreshed = page.waitForResponse(
    response =>
      response.url().endsWith(`/api/his/v1/doctor/cases/${consultationCase.outpatientCaseId}`)
      && response.request().method() === 'GET'
      && response.status() === 200,
  )
  await revisionForm.getByRole('button', { name: '放弃修订草稿', exact: true }).click()
  await discardCaseRefreshed
  await expect(page.getByText('存在待签署的病历修订草稿', { exact: true })).toHaveCount(0)
  await expect.poll(async () => (await readCompletion()).canComplete).toBe(true)

  await page.getByRole('button', { name: '修改病历', exact: true }).click()
  await expect(revisionForm.getByRole('button', { name: '保存修订草稿', exact: true })).toBeEnabled()
  await revisionForm.getByLabel('辅助检查', { exact: true }).fill('门诊补充记录：生命体征复测平稳。')
  const saveCaseRefreshed = page.waitForResponse(
    response =>
      response.url().endsWith(`/api/his/v1/doctor/cases/${consultationCase.outpatientCaseId}`)
      && response.request().method() === 'GET'
      && response.status() === 200,
  )
  await revisionForm.getByRole('button', { name: '保存修订草稿', exact: true }).click()
  await saveCaseRefreshed
  await expect(revisionForm.getByRole('button', { name: '保存修订草稿', exact: true })).toBeEnabled()
  await expect(page.getByText('存在待签署的病历修订草稿', { exact: true })).toBeVisible()
  await revisionForm.getByLabel('修订原因', { exact: true }).fill('补充门诊诊间复测记录。')
  const submitRevisionButton = revisionForm.getByRole('button', { name: '提交病历修订', exact: true })
  await expect(submitRevisionButton).toBeEnabled()
  await expect(submitRevisionButton).not.toHaveAttribute('data-unavailable', '')
  await submitRevisionButton.click()
  const confirmRevisionDialog = page.getByRole('alertdialog', { name: '确认提交病历修订', exact: true })
  await expect(confirmRevisionDialog).toBeVisible()
  await confirmRevisionDialog.getByRole('button', { name: '确认提交修订', exact: true }).click()
  await expect(confirmRevisionDialog).toHaveCount(0)
  await expect.poll(async () => (await readCase()).clinicalDocument?.signed.length).toBe(2)
  await expect.poll(async () => (await readCompletion()).canComplete).toBe(true)

  expect(errors).toEqual([])
})
