import { openWorkspaceTab } from './workspace-tabs.fixture.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { confirmDoctorPreparationRequestSchema, type ConfirmDoctorPreparationRequest } from '@clinmesh/contracts/doctor-recommendations'
import {
  billingCaseSchema,
  billingQueueSchema,
  clinicalCatalogSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  doctorCaseDetailSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  pharmacyQueueSchema,
} from '@clinmesh/contracts/his'
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { signInCashier, submitPayment } from './billing-payments.fixture.ts'
import { test as base, expect } from './fixtures.ts'
import { createInvestigationReferenceDatabase } from './investigation-workspace.fixture.ts'
import { closeQueue, expectConsultationStarted, openQueue } from './queue-overlay.fixture.ts'

const products: ReferenceMedicationProduct[] = [10, 20].map(count => ({
  id: `synthetic-acetaminophen-${count}`, code: `synthetic-acetaminophen-${count}`, genericName: '对乙酰氨基酚片',
  approvalNumber: '国药准字H20260001', brandName: '合成退热药', dosageForm: '片剂', manufacturer: '合成制药厂',
  packageDescription: `${count}片/盒`, sourceLocator: `synthetic:browser:acetaminophen:${count}`,
  status: 'active', strength: '500 mg', system: 'https://clinmesh.example.com/medications', version: '1',
}))

const test = base.extend<{ consultationCase: Awaited<ReturnType<typeof startConsultationCase>> }>({
  browserApp: async ({ webRoot }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-prescription-e2e-'))
    try {
      const referenceDatabasePath = await createInvestigationReferenceDatabase(directory, products)
      const app = await startBrowserServer(webRoot, {
        activeReferenceReleaseId: 'investigation-e2e-v1', referenceDatabasePath,
        patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(),
        chatCompletionsProvider: { completeJson: async input => {
          if (input.schemaName === 'patient_persona') {
            return { model: input.model, content: JSON.stringify(persona) }
          }
          if (input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification') {
            const payload = z.object({ agentFacts: z.array(z.object({ id: z.string() })), issues: z.array(z.unknown()).optional() }).parse(input.userPayload)
            return {
              model: input.model,
              content: JSON.stringify({
                issues: input.schemaName === 'clinical_document_quality_verification'
                  ? (payload.issues ?? []).map((_, index) => ({ index, supported: true }))
                  : [],
                agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
              }),
            }
          }
          throw new Error(`Unexpected schema: ${input.schemaName}`)
        } },
      })
      try { await use(app) }
      finally { await app.close() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  },
  consultationCase: async ({ browserApp }, use) => {
    await use(await startConsultationCase(browserApp.runtime, browserApp.password, browserApp.origin))
  },
})

for (const width of [1280, 390]) test(`keeps manual diagnosis and prescription issuance available when Agent reads fail at ${width}px`, async ({ page, browserApp, consultationCase }) => {
  const errors: string[] = []
  const confirmations: ConfirmDoctorPreparationRequest[] = []
  await page.route(/\/recommendations\/(diagnosis|prescription|laboratory|imaging|pathology)$/, route => route.abort('failed'))
  page.on('request', request => {
    if (/\/recommendations\/(diagnosis|prescription)\/actions\/confirm$/.test(new URL(request.url()).pathname)) {
      confirmations.push(confirmDoctorPreparationRequestSchema.parse(request.postDataJSON()))
    }
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await openQueue(page)
  await page.getByRole('tab', { name: '待诊', exact: true }).click()

  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await expectConsultationStarted(page)

  const queueNavigation = page.getByRole('tablist', { name: '门诊诊疗', exact: true })
  await openQueue(page)
  for (const label of ['在诊', '待诊', '完诊']) await expect(queueNavigation.getByRole('tab', { name: label, exact: true })).toContainText(/\d/)
  const widths = await queueNavigation.getByRole('tab').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width))
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
  await closeQueue(page)
  const readCase = async () => {
    const response = await page.request.get(`${browserApp.origin}/api/his/v1/doctor/cases/${consultationCase.outpatientCaseId}`)
    expect(response.status()).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  }
  const catalog = clinicalCatalogSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/catalogs/clinical`)).json())
  if (!catalog.prescriptionConclusionSupported) throw new Error('The synthetic case must support independent prescriptions')
  const medication = catalog.medications.find(item => item.id === 'medication-acetaminophen')
  const diagnosis = catalog.diagnoses.find(item => item.code === 'R50.9')
  if (medication === undefined || diagnosis === undefined) throw new Error('The synthetic fixture must provide the fever and acetaminophen pair')

  await openWorkspaceTab(page, '诊断')
  const diagnosisSection = page.locator('[data-agent-section="diagnosis"]')
  const diagnosisEntry = diagnosisSection.getByRole('region', { name: '填写诊断', exact: true })
  await expect(diagnosisEntry.getByRole('button', { name: '添加诊断', exact: true })).toBeVisible()
  expect((await readCase()).diagnosis?.draft).toBeUndefined()
  // 弹窗合同：目录浏览、选择与诊断信息填写在同一次「选择诊断」弹窗内完成。
  await diagnosisEntry.getByRole('button', { name: '添加诊断', exact: true }).click()
  const diagnosisComposer = page.getByRole('dialog', { name: '选择诊断', exact: true })
  // 该病例没有参考疾病数据，弹窗打开后直接列出本院目录。
  await diagnosisComposer.getByRole('button', { name: `选择 ${diagnosis.nameZh} ${diagnosis.code}`, exact: true }).click()
  await diagnosisComposer.getByLabel('诊断备注', { exact: true }).fill('合成病例：根据当前问诊与查体确认。')
  await diagnosisComposer.getByRole('button', { name: '加入诊断', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(diagnosisSection.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  const pendingDiagnoses = page.getByRole('region', { name: '待确认诊断', exact: true })
  await expect(page.getByRole('button', { name: '确认诊断', exact: true })).toHaveCount(0)
  await pendingDiagnoses.getByRole('button', { name: /^确认选中诊断/ }).click()
  const list = page.getByRole('region', { name: '诊断列表', exact: true })
  await expect(list).toBeVisible()
  await expect(diagnosisEntry.getByRole('button', { name: '添加诊断', exact: true })).toBeVisible()
  expect((await readCase()).diagnosis?.confirmation?.revisionNumber).toBe(1)

  await page.getByRole('button', { name: '修改已确认诊断', exact: true }).click()
  const openPending = pendingDiagnoses.getByRole('button', { name: `查看待开具 ${diagnosis.nameZh}`, exact: true })
  await openPending.click()
  const pendingDetail = page.getByRole('region', { name: '待开具项目详情', exact: true })
  await expect(pendingDetail).toBeVisible()
  await expect(page.getByRole('dialog', { name: '调整项目', exact: true })).toHaveCount(0)
  await pendingDetail.getByRole('textbox', { name: '备注', exact: true }).fill('合成病例：复核后补充诊断说明。')
  await expect(pendingDetail.getByRole('button', { name: /^确认选中诊断/ })).toBeDisabled()
  await expect(list.getByRole('cell', { name: '合成病例：根据当前问诊与查体确认。', exact: true })).toBeVisible()
  await expect(pendingDetail.getByRole('textbox', { name: '备注', exact: true })).toHaveValue('合成病例：复核后补充诊断说明。')
  await pendingDetail.getByRole('button', { name: '保留本次调整', exact: true }).click()
  await expect(page.locator('[data-agent-section="diagnosis"]').getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await expect(pendingDiagnoses.getByRole('button', { name: /^确认选中诊断/ })).toHaveCount(0)
  await pendingDetail.getByRole('button', { name: /^确认选中诊断/ }).click()
  await expect.poll(async () => (await readCase()).diagnosis?.confirmation?.revisionNumber).toBe(2)
  expect((await readCase()).diagnosis?.confirmation?.entries[0]?.note).toBe('合成病例：复核后补充诊断说明。')
  await expect(list.getByRole('cell', { name: '合成病例：复核后补充诊断说明。', exact: true })).toBeVisible()
  await list.getByLabel('搜索本次诊断').fill('没有匹配项')
  await expect(list.getByText('没有匹配的诊断', { exact: true })).toBeVisible()
  expect((await readCase()).diagnosis?.confirmation?.entries).toHaveLength(1)
  await list.getByRole('button', { name: '查看全部诊断', exact: true }).click()
  // 列表视图下追加诊断同样经弹窗完成：空检索列出本院目录，检索无结果时给出空态。
  await diagnosisEntry.getByRole('button', { name: '添加诊断', exact: true }).click()
  const appendComposer = page.getByRole('dialog', { name: '选择诊断', exact: true })
  await expect(appendComposer.getByRole('button', { name: `选择 ${diagnosis.nameZh} ${diagnosis.code}`, exact: true })).toBeVisible()
  await appendComposer.getByLabel('搜索疾病目录', { exact: true }).fill('没有匹配项')
  await appendComposer.getByRole('button', { name: '执行疾病目录搜索', exact: true }).click()
  await expect(appendComposer.getByText('没有匹配记录', { exact: true })).toBeVisible()
  await appendComposer.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await openWorkspaceTab(page, '处方')
  const prescriptionSection = page.locator('[data-agent-section="prescription"]')
  const medicationEntry = prescriptionSection.getByRole('region', { name: '填写处方', exact: true })
  const pendingPrescription = page.getByRole('region', { name: '待开具处方', exact: true })
  await expect(medicationEntry.getByRole('button', { name: '添加药品', exact: true })).toBeVisible()
  await expect(medicationEntry.getByText('存在未完成的药品信息，点击对应条目补全后才能开具。', { exact: true })).toHaveCount(0)
  expect((await readCase()).medicationConclusion?.draft).toBeUndefined()
  // 弹窗合同：默认打开「本院药房」；显式切换至「国家参考目录」后检索参考产品（用于编辑与删除草稿，暂不开具）。
  await medicationEntry.getByRole('button', { name: '添加药品', exact: true }).click()
  const medicationComposer = page.getByRole('dialog', { name: '选择药品', exact: true })
  await expect(medicationComposer.getByRole('tab', { name: '本院药房', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(medicationComposer.getByRole('button', { name: `选择 ${medication.nameZh}`, exact: true })).toContainText('¥1.20')
  await medicationComposer.getByRole('tab', { name: '国家参考目录', exact: true }).click()
  await expect(medicationComposer.getByText('国家参考目录药品仅生成电子外延处方，不在本院收费与药房发药。', { exact: true })).toBeVisible()
  await medicationComposer.getByLabel('搜索药品目录', { exact: true }).fill(medication.nameZh)
  await medicationComposer.getByRole('button', { name: '执行药品目录搜索', exact: true }).click()
  const packageChoice = medicationComposer.getByRole('combobox', { name: `包装 ${medication.nameZh} 合成制药厂` })
  await expect(packageChoice).toContainText('10片/盒')
  await medicationComposer.getByRole('button', { name: `选择 ${medication.nameZh} 500 mg 10片/盒 合成制药厂 国药准字H20260001`, exact: true }).click()
  const dosage = medicationComposer.getByRole('region', { name: '用药信息', exact: true })
  await dosage.getByLabel('剂量', { exact: true }).fill(medication.defaultDoseText)
  await dosage.getByLabel('频次', { exact: true }).fill(medication.defaultFrequencyCode)
  await dosage.getByLabel('疗程', { exact: true }).fill(String(medication.defaultCourseDays))
  await dosage.getByLabel('数量', { exact: true }).fill(String(medication.defaultQuantity))
  await medicationComposer.getByRole('button', { name: '加入处方', exact: true }).click()
  await expect(medicationComposer).toBeVisible()
  await medicationComposer.getByRole('button', { name: '完成选择', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(medicationEntry.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  // 弹窗合同下编辑同样在弹窗内完成：拦截 PUT 制造保存失败，再走重试保存。
  await pendingPrescription.getByRole('button', { name: '编辑药品 对乙酰氨基酚片', exact: true }).click()
  const editComposer = page.getByRole('dialog', { name: '编辑药品', exact: true })
  await expect(editComposer.getByRole('tab', { name: '国家参考目录', exact: true })).toHaveAttribute('aria-selected', 'true')
  const editDose = editComposer.getByLabel('剂量', { exact: true })
  await expect(editDose).toHaveValue(medication.defaultDoseText)
  const draftPath = `**/encounters/${(await readCase()).encounter.id}/prescription/draft`
  let rejectedSave = false
  await page.route(draftPath, route => {
    if (!rejectedSave && route.request().method() === 'PUT') {
      rejectedSave = true
      return route.abort('failed')
    }
    return route.continue()
  })
  await editDose.fill('500 mg（合成新输入）')
  await editComposer.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // 弹窗关闭后输入并入本地草稿：卡片先呈现新值，保存失败时仍保留。
  await expect(pendingPrescription).toContainText('500 mg（合成新输入）')
  await medicationEntry.getByRole('button', { name: '重试保存', exact: true }).click()
  expect(rejectedSave).toBe(true)
  await expect(pendingPrescription).toContainText('500 mg（合成新输入）')
  await expect.poll(async () => (await readCase()).medicationConclusion?.draft?.items[0]?.doseText).toBe('500 mg（合成新输入）')
  await expect(medicationEntry.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await page.unroute(draftPath)
  await expect(page.getByRole('button', { name: '正式开具处方', exact: true })).toHaveCount(0)
  let releaseDeletion!: () => void
  let deletionCompleted!: () => void
  const deletionHeld = new Promise<void>(resolve => { releaseDeletion = resolve })
  const deletionReady = new Promise<void>(resolve => { deletionCompleted = resolve })
  await page.route(draftPath, async route => {
    if (route.request().method() !== 'DELETE') return route.continue()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    deletionCompleted()
    await deletionHeld
    await route.fulfill({ response })
  })
  try {
    await page.getByRole('button', { name: '删除处方草稿', exact: true }).click()
    await page.getByRole('alertdialog', { name: '确认删除处方草稿', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click()
    await deletionReady
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    // 删除挂起期间入口禁用，完成后恢复，可再次添加药品。
    await expect(medicationEntry.getByRole('button', { name: '添加药品', exact: true })).toBeDisabled()
    releaseDeletion()
    await expect.poll(async () => (await readCase()).medicationConclusion?.draft).toBeUndefined()
    await expect(pendingPrescription.getByRole('checkbox')).toHaveCount(0)
    await expect(medicationEntry.getByRole('button', { name: '添加药品', exact: true })).toBeEnabled()
    await expect(medicationEntry.getByText('存在未完成的药品信息，点击对应条目补全后才能开具。', { exact: true })).toHaveCount(0)
  } finally {
    releaseDeletion()
    await page.unroute(draftPath)
  }
  // 重新添加并在弹窗内切换包装为 20片/盒，这条才是最终开具的药品。
  await medicationEntry.getByRole('button', { name: '添加药品', exact: true }).click()
  const finalComposer = page.getByRole('dialog', { name: '选择药品', exact: true })
  await finalComposer.getByRole('tab', { name: '国家参考目录', exact: true }).click()
  await finalComposer.getByLabel('搜索药品目录', { exact: true }).fill(medication.nameZh)
  await finalComposer.getByRole('button', { name: '执行药品目录搜索', exact: true }).click()
  const finalPackage = finalComposer.getByRole('combobox', { name: `包装 ${medication.nameZh} 合成制药厂` })
  await finalPackage.click()
  await page.getByRole('option', { name: '20片/盒', exact: true }).click()
  await finalComposer.getByRole('button', { name: `选择 ${medication.nameZh} 500 mg 20片/盒 合成制药厂 国药准字H20260001`, exact: true }).click()
  const finalDetails = finalComposer.getByRole('region', { name: '用药信息', exact: true })
  await finalDetails.getByLabel('剂量', { exact: true }).fill(medication.defaultDoseText)
  await finalDetails.getByLabel('频次', { exact: true }).fill(medication.defaultFrequencyCode)
  await finalDetails.getByLabel('疗程', { exact: true }).fill(String(medication.defaultCourseDays))
  await finalDetails.getByLabel('数量', { exact: true }).fill(String(medication.defaultQuantity))
  await finalComposer.getByRole('button', { name: '加入处方', exact: true }).click()
  await finalComposer.getByRole('button', { name: '完成选择', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(medicationEntry.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await pendingPrescription.getByRole('button', { name: /^开具处方/ }).click()
  const medications = page.getByRole('region', { name: '药品列表', exact: true })
  await expect(medications).toBeVisible()
  await expect.poll(async () => (await readCase()).medicationConclusion?.prescription?.status).toBe('signed')
  await expect(medicationEntry).toBeVisible()
  await expect(medications.getByRole('cell', { name: medication.nameZh, exact: true })).toBeVisible()
  await expect(medications).toContainText(medication.defaultDoseText)
  await page.getByLabel('搜索处方药品').fill('没有匹配项')
  await expect(medications.getByText('没有匹配的记录', { exact: true })).toBeVisible()
  expect((await readCase()).medicationConclusion?.prescription?.items).toHaveLength(1)
  await medications.getByRole('button', { name: '查看全部记录', exact: true }).click()

  await page.reload()
  await openWorkspaceTab(page, '处方')
  await expect(medications).toBeVisible()
  await page.getByRole('button', { name: '撤回处方', exact: true }).click()
  await page.getByRole('alertdialog', { name: '确认撤回处方', exact: true }).getByRole('button', { name: '确认撤回', exact: true }).click()
  await expect.poll(async () => (await readCase()).medicationConclusion?.prescription?.status).toBe('withdrawn')
  await page.getByRole('button', { name: '无需用药', exact: true }).click()
  await page.getByRole('button', { name: '确认无需用药', exact: true }).click()
  await page.getByRole('alertdialog', { name: '确认无需用药', exact: true }).getByRole('button', { name: '确认无需用药', exact: true }).click()
  await expect(page.getByText('已确认无需用药', { exact: true })).toBeVisible()
  expect((await readCase()).medicationConclusion?.prescription?.items).toHaveLength(1)
  expect((await readCase()).medicationConclusion?.noMedication).toBeDefined()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(confirmations).toHaveLength(3)
  for (const confirmation of confirmations) {
    expect(confirmation.input.generation).toBeUndefined()
    expect(confirmation.input.inputFingerprint).toBeUndefined()
    expect(confirmation.input.selections.every(selection => selection.source === 'manual')).toBe(true)
  }
  expect((await readCase()).medicationConclusion?.prescription?.items[0]?.catalogItemId).toBe('synthetic-acetaminophen-20')
  expect(confirmations[2]?.input.selections[0]).toMatchObject({ referenceProduct: { id: 'synthetic-acetaminophen-20', packageDescription: '20片/盒' } })
  expect(errors).toEqual([])
})

async function signAndCompleteEncounter(page: import('@playwright/test').Page, origin: string, caseId: string) {
  const detail = doctorCaseDetailSchema.parse(await (await page.request.get(`${origin}/api/his/v1/doctor/cases/${caseId}`)).json())
  const encounterRef = `Encounter/${detail.encounter.id}`
  const basePath = `/api/his/v1/encounters/${detail.encounter.id}`
  const command = async (target: string, input: object, method = 'POST') => {
    const response = await page.request.fetch(`${origin}${target}`, {
      method,
      headers: { origin, 'idempotency-key': randomUUID() },
      data: { expectedVersions: { [encounterRef]: detail.encounter.versionId }, input },
    })
    expect(response.status(), target).toBe(200)
    return response.json()
  }
  const draft = clinicalDocumentDraftResponseSchema.parse(await command(`${basePath}/clinical-document/draft`, {
    expectedDraftVersion: detail.clinicalDocument?.draft?.version ?? 0,
    document: {
      assessment: '合成发热病例诊断与用药结论已记录。',
      chiefComplaint: '合成发热伴头痛一天。',
      disposition: '门诊按医嘱观察与对症处理。',
      followUp: '高热不退或症状加重时及时复诊。',
      historyOfPresentIllness: '一天前出现发热伴头痛，无呼吸困难。',
      menstrualHistory: '患者自述已绝经，年龄记不清。', obstetricHistory: '患者自述孕2产2。', physicalExamination: '神志清楚，双肺呼吸音清。',
    },
  }, 'PUT')).data
  const preview = clinicalDocumentSignPreviewResponseSchema.parse(await command(`${basePath}/clinical-document/actions/preview-sign`, {
    expectedDraftVersion: draft.draftVersion,
  })).data
  clinicalDocumentSignResponseSchema.parse(await command(`${basePath}/clinical-document/actions/sign`, {
    commitToken: preview.commitToken,
    previewId: preview.previewId,
  }))
  const completion = encounterCompletionPreviewSchema.parse(await (await page.request.get(`${origin}${basePath}/completion`)).json())
  expect(completion.canComplete).toBe(true)
  expect(completion.items.find(item => item.code === 'medication-conclusion-recorded')?.status).toBe('complete')
  const refreshed = doctorCaseDetailSchema.parse(await (await page.request.get(`${origin}/api/his/v1/doctor/cases/${caseId}`)).json())
  const completeResponse = await page.request.fetch(`${origin}${basePath}/actions/complete`, {
    method: 'POST',
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { expectedVersions: { [encounterRef]: refreshed.encounter.versionId }, input: {} },
  })
  expect(completeResponse.status()).toBe(200)
  return encounterCompletionResponseSchema.parse(await completeResponse.json()).data
}

test('completes hospital pharmacy prescription billing and dispensing from default local tab and shows specific indication error', async ({ page, browserApp, consultationCase }) => {
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

  // 确认主诊断 R50.9（发热，未特指）
  await openWorkspaceTab(page, '诊断')
  await page.locator('[data-agent-section="diagnosis"]').getByRole('button', { name: '添加诊断', exact: true }).click()
  const diagnosisDialog = page.getByRole('dialog', { name: '选择诊断', exact: true })
  await diagnosisDialog.getByRole('button', { name: '选择 发热，未特指 R50.9', exact: true }).click()
  await diagnosisDialog.getByRole('button', { name: '加入诊断', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('region', { name: '待确认诊断', exact: true }).getByRole('button', { name: /^确认选中诊断/ }).click()
  await expect(page.getByRole('region', { name: '诊断列表', exact: true })).toBeVisible()

  // 处方页：先选适应证仅限流感的奥司他韦，验证具体适应证不符原因。
  await openWorkspaceTab(page, '处方')
  const medicationEntry = page.locator('[data-agent-section="prescription"]').getByRole('region', { name: '填写处方', exact: true })
  const pendingPrescription = page.getByRole('region', { name: '待开具处方', exact: true })
  await medicationEntry.getByRole('button', { name: '添加药品', exact: true }).click()
  const oseltamivirDialog = page.getByRole('dialog', { name: '选择药品', exact: true })
  await expect(oseltamivirDialog.getByRole('tab', { name: '本院药房', exact: true })).toHaveAttribute('aria-selected', 'true')
  await oseltamivirDialog.getByRole('button', { name: '选择 磷酸奥司他韦胶囊', exact: true }).click()
  await oseltamivirDialog.getByRole('button', { name: '加入处方', exact: true }).click()
  await oseltamivirDialog.getByRole('button', { name: '完成选择', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(medicationEntry.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await pendingPrescription.getByRole('button', { name: /^开具处方/ }).click()
  await expect(pendingPrescription.getByText('已确认的诊断不在该药品允许的目录范围内。请调整诊断或更换药品。', { exact: true })).toBeVisible()

  // 将唯一条目替换为 R50.9 允许的本院药房对乙酰氨基酚片并正式开具
  await pendingPrescription.getByRole('button', { name: '编辑药品 磷酸奥司他韦胶囊', exact: true }).click()
  const replaceDialog = page.getByRole('dialog', { name: '编辑药品', exact: true })
  await expect(replaceDialog.getByRole('tab', { name: '本院药房', exact: true })).toHaveAttribute('aria-selected', 'true')
  await replaceDialog.getByRole('button', { name: '选择 对乙酰氨基酚片', exact: true }).click()
  await replaceDialog.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(medicationEntry.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await pendingPrescription.getByRole('button', { name: /^开具处方/ }).click()
  await expect(page.getByRole('region', { name: '药品列表', exact: true })).toBeVisible()

  await signAndCompleteEncounter(page, browserApp.origin, consultationCase.outpatientCaseId)

  // 门诊收费：存在真实金额药品待缴账单并完成收款
  await page.context().clearCookies()
  await signInCashier(page, browserApp)
  const pendingBills = billingQueueSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/billing/queue?category=medication&status=pending`)).json())
  const medicationBill = pendingBills.items.find(item => item.caseId === consultationCase.outpatientCaseId)
  expect(medicationBill?.amountFen).toBe(720)
  await page.getByRole('combobox', { name: '费用类别', exact: true }).click()
  await page.getByRole('option', { name: '药品费用', exact: true }).click()
  await page.locator(`[data-agent-selection="${medicationBill!.chargeItemId}"]`).click()
  await submitPayment(page)

  // 门诊药房：审核通过并按批次发药
  const pharmacistLogin = await page.request.post(`${browserApp.origin}/api/auth/sign-in/email`, {
    headers: { origin: browserApp.origin },
    data: { email: 'pharmacist@demo.clinmesh.local', password: browserApp.password },
  })
  expect(pharmacistLogin.status()).toBe(200)
  await page.goto(`${browserApp.origin}/pharmacy`)
  await expect(page.getByRole('heading', { name: '发药队列', exact: true })).toBeVisible()
  const action = page.getByRole('region', { name: '当前操作', exact: true })
  await page.getByLabel('审核意见', { exact: true }).fill('合成药师核对本院药房处方无误')
  await action.getByRole('button', { name: '审核处方', exact: true }).click()
  await action.getByRole('button', { name: '审核通过', exact: true }).click()
  await expect(action.getByRole('button', { name: '审阅发药', exact: true })).toBeEnabled()
  await action.getByRole('button', { name: '审阅发药', exact: true }).click()
  await action.getByRole('button', { name: '确认发药', exact: true }).click()
  await expect(page.getByText('本次发药', { exact: true })).toBeVisible()
  const completedPharmacy = pharmacyQueueSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/pharmacy/queue?status=completed`)).json())
  expect(completedPharmacy.items.find(item => item.caseId === consultationCase.outpatientCaseId)?.medications[0]).toMatchObject({
    dispensedQuantity: 6,
    remainingQuantity: 0,
  })
})

test('completes encounter with national reference external prescription without creating pending medication charges or pharmacy queue items', async ({ page, browserApp, consultationCase }) => {
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

  await openWorkspaceTab(page, '诊断')
  await page.locator('[data-agent-section="diagnosis"]').getByRole('button', { name: '添加诊断', exact: true }).click()
  const diagnosisDialog = page.getByRole('dialog', { name: '选择诊断', exact: true })
  await diagnosisDialog.getByRole('button', { name: '选择 发热，未特指 R50.9', exact: true }).click()
  await diagnosisDialog.getByRole('button', { name: '加入诊断', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('region', { name: '待确认诊断', exact: true }).getByRole('button', { name: /^确认选中诊断/ }).click()
  await expect(page.getByRole('region', { name: '诊断列表', exact: true })).toBeVisible()

  await openWorkspaceTab(page, '处方')
  const medicationEntry = page.locator('[data-agent-section="prescription"]').getByRole('region', { name: '填写处方', exact: true })
  await medicationEntry.getByRole('button', { name: '添加药品', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '选择药品', exact: true })
  await expect(dialog.getByRole('tab', { name: '本院药房', exact: true })).toHaveAttribute('aria-selected', 'true')
  await dialog.getByRole('tab', { name: '国家参考目录', exact: true }).click()
  await expect(dialog.getByText('国家参考目录药品仅生成电子外延处方，不在本院收费与药房发药。', { exact: true })).toBeVisible()
  await dialog.getByLabel('搜索药品目录', { exact: true }).fill('对乙酰氨基酚片')
  await dialog.getByRole('button', { name: '执行药品目录搜索', exact: true }).click()
  await dialog.getByRole('button', { name: '选择 对乙酰氨基酚片 500 mg 10片/盒 合成制药厂 国药准字H20260001', exact: true }).click()
  const details = dialog.getByRole('region', { name: '用药信息', exact: true })
  await details.getByLabel('剂量', { exact: true }).fill('500 mg')
  await details.getByLabel('频次', { exact: true }).fill('PRN')
  await details.getByLabel('疗程', { exact: true }).fill('3')
  await details.getByLabel('数量', { exact: true }).fill('2')
  await dialog.getByRole('button', { name: '加入处方', exact: true }).click()
  await dialog.getByRole('button', { name: '完成选择', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(medicationEntry.getByText('草稿已自动保存', { exact: true })).toBeVisible()

  await page.getByRole('region', { name: '待开具处方', exact: true }).getByRole('button', { name: /^开具处方/ }).click()
  await expect(page.getByText('电子外延处方已开具，不在本院收费或药房发药。', { exact: true })).toBeVisible()

  await signAndCompleteEncounter(page, browserApp.origin, consultationCase.outpatientCaseId)

  // 门诊收费：无 0 元药品待缴账单
  await page.context().clearCookies()
  await signInCashier(page, browserApp)
  const pendingBills = billingQueueSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/billing/queue?category=medication&status=pending`)).json())
  expect(pendingBills.items.filter(item => item.caseId === consultationCase.outpatientCaseId)).toHaveLength(0)
  const billDetail = billingCaseSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/billing/cases/${consultationCase.outpatientCaseId}`)).json())
  expect(billDetail.charges.filter(charge => charge.category === 'medication')).toHaveLength(0)

  // 门诊药房：不进入本院药房待发队列
  const pharmacistLogin = await page.request.post(`${browserApp.origin}/api/auth/sign-in/email`, {
    headers: { origin: browserApp.origin },
    data: { email: 'pharmacist@demo.clinmesh.local', password: browserApp.password },
  })
  expect(pharmacistLogin.status()).toBe(200)
  const pharmacyQueue = pharmacyQueueSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/pharmacy/queue?status=pending`)).json())
  expect(pharmacyQueue.items.filter(item => item.caseId === consultationCase.outpatientCaseId)).toHaveLength(0)
})
