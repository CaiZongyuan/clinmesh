import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmDoctorPreparationRequestSchema, type ConfirmDoctorPreparationRequest } from '@clinmesh/contracts/doctor-recommendations'
import { clinicalCatalogSchema, doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { test as base, expect } from './fixtures.ts'
import { createInvestigationReferenceDatabase } from './investigation-workspace.fixture.ts'

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
          expect(input.schemaName).toBe('patient_persona')
          return { model: input.model, content: JSON.stringify(persona) }
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
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  if (width === 390) await page.getByRole('button', { name: '候诊患者', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()

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

  await page.getByRole('tab', { name: '诊断', exact: true }).click()
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
  await list.getByRole('button', { name: new RegExp(diagnosis.nameZh) }).click()
  await expect(pendingDetail).toBeHidden()
  await expect(page.getByRole('region', { name: '诊断详情', exact: true }).getByText('合成病例：根据当前问诊与查体确认。', { exact: true })).toBeVisible()
  await openPending.click()
  await expect(pendingDetail.getByRole('textbox', { name: '备注', exact: true })).toHaveValue('合成病例：复核后补充诊断说明。')
  await pendingDetail.getByRole('button', { name: '保留本次调整', exact: true }).click()
  await expect(page.locator('[data-agent-section="diagnosis"]').getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await expect(pendingDiagnoses.getByRole('button', { name: /^确认选中诊断/ })).toHaveCount(0)
  await pendingDetail.getByRole('button', { name: /^确认选中诊断/ }).click()
  await expect.poll(async () => (await readCase()).diagnosis?.confirmation?.revisionNumber).toBe(2)
  expect((await readCase()).diagnosis?.confirmation?.entries[0]?.note).toBe('合成病例：复核后补充诊断说明。')
  if (width === 390) await page.getByRole('button', { name: '返回诊断列表', exact: true }).click()
  await list.getByRole('button', { name: new RegExp(diagnosis.nameZh) }).click()
  const details = page.getByRole('region', { name: '诊断详情', exact: true })
  await expect(details.getByText('合成病例：复核后补充诊断说明。', { exact: true })).toBeVisible()
  await expect(details.getByLabel('诊断备注', { exact: true })).toHaveCount(0)
  if (width === 390) await details.getByRole('button', { name: '返回诊断列表', exact: true }).click()
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

  await page.getByRole('tab', { name: '处方', exact: true }).click()
  const prescriptionSection = page.locator('[data-agent-section="prescription"]')
  const medicationEntry = prescriptionSection.getByRole('region', { name: '填写处方', exact: true })
  await expect(medicationEntry.getByRole('button', { name: '添加药品', exact: true })).toBeVisible()
  await expect(medicationEntry.getByText('选择药品，填写用法', { exact: true })).toBeVisible()
  await expect(medicationEntry.getByText('存在未完成的药品信息，点击对应条目补全后才能开具。', { exact: true })).toHaveCount(0)
  expect((await readCase()).medicationConclusion?.draft).toBeUndefined()
  // 弹窗合同：本院药行仅在参考目录结果为空时出现，这里首条草稿使用参考产品（仅用于编辑与删除，不开具）。
  await medicationEntry.getByRole('button', { name: '添加药品', exact: true }).click()
  const medicationComposer = page.getByRole('dialog', { name: '选择药品', exact: true })
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
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(medicationEntry.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  // 弹窗合同下编辑同样在弹窗内完成：拦截 PUT 制造保存失败，再走重试保存。
  await medicationEntry.getByRole('button', { name: '编辑药品 对乙酰氨基酚片', exact: true }).click()
  const editComposer = page.getByRole('dialog', { name: '编辑药品', exact: true })
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
  await expect(medicationEntry.getByRole('button', { name: '编辑药品 对乙酰氨基酚片', exact: true })).toContainText('500 mg（合成新输入）')
  await medicationEntry.getByRole('button', { name: '重试保存', exact: true }).click()
  expect(rejectedSave).toBe(true)
  await expect(medicationEntry.getByRole('button', { name: '编辑药品 对乙酰氨基酚片', exact: true })).toContainText('500 mg（合成新输入）')
  await expect.poll(async () => (await readCase()).medicationConclusion?.draft?.items[0]?.doseText).toBe('500 mg（合成新输入）')
  await expect(medicationEntry.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await page.unroute(draftPath)
  const pendingPrescription = page.getByRole('region', { name: '待开具处方', exact: true })
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
    await expect(medicationEntry.getByText('选择药品，填写用法', { exact: true })).toBeVisible()
    await expect(medicationEntry.getByText('存在未完成的药品信息，点击对应条目补全后才能开具。', { exact: true })).toHaveCount(0)
  } finally {
    releaseDeletion()
    await page.unroute(draftPath)
  }
  // 重新添加并在弹窗内切换包装为 20片/盒，这条才是最终开具的药品。
  await medicationEntry.getByRole('button', { name: '添加药品', exact: true }).click()
  const finalComposer = page.getByRole('dialog', { name: '选择药品', exact: true })
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
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(medicationEntry.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await pendingPrescription.getByRole('button', { name: /^开具处方/ }).click()
  const medications = page.getByRole('region', { name: '药品列表', exact: true })
  if (width === 390) await page.getByRole('button', { name: '返回药品列表', exact: true }).click()
  await expect(medications).toBeVisible()
  await expect.poll(async () => (await readCase()).medicationConclusion?.prescription?.status).toBe('signed')
  await expect(medicationEntry).toBeVisible()
  await medications.getByRole('button', { name: `查看药品 ${medication.nameZh}`, exact: true }).click()
  const medicationDetails = page.getByRole('region', { name: '药品详情', exact: true })
  await expect(medicationDetails.getByText(medication.defaultDoseText, { exact: true })).toBeVisible()
  await expect(medicationDetails.getByRole('combobox')).toHaveCount(0)
  if (width === 390) await medicationDetails.getByRole('button', { name: '返回药品列表', exact: true }).click()
  await page.getByLabel('搜索处方药品').fill('没有匹配项')
  await expect(medications.getByText('没有匹配的记录', { exact: true })).toBeVisible()
  expect((await readCase()).medicationConclusion?.prescription?.items).toHaveLength(1)
  await medications.getByRole('button', { name: '查看全部记录', exact: true }).click()

  await page.reload()
  await page.getByRole('tab', { name: '处方', exact: true }).click()
  if (width === 390) await page.getByRole('button', { name: '返回药品列表', exact: true }).click()
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
