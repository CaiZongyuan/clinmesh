import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { confirmDoctorPreparationRequestSchema, confirmDoctorPreparationResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { clinicalCatalogSchema, doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { closeQueue, expectConsultationStarted, openQueue } from './queue-overlay.fixture.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

export async function runOutpatientPrescriptionBatchJourney({ page, browserApp, consultationCase, step = async () => {} }: {
  page: Page; browserApp: { origin: string; password: string }; consultationCase: { outpatientCaseId: string }
  step?: (caption: string) => Promise<void>
}) {
  const posts: Array<{ key: string; body: unknown }> = [], receiptReads: string[] = [], errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path.endsWith('/recommendations/prescription/actions/confirm')) {
      posts.push({ key: request.headers()['idempotency-key']!, body: request.postDataJSON() })
    }
    if (request.method() === 'GET' && path.includes('/recommendations/prescription/confirmations/')) receiptReads.push(path)
  })
  await page.route(/\/recommendations\/(diagnosis|prescription|laboratory|imaging|pathology)$/, route => route.abort('failed'))
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
  const catalog = clinicalCatalogSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/catalogs/clinical`)).json())
  if (!catalog.prescriptionConclusionSupported) throw new Error('Synthetic prescription catalog missing')
  const medications = ['medication-acetaminophen', 'medication-oseltamivir'].map(id => {
    const item = catalog.medications.find(item => item.id === id)
    if (item === undefined) throw new Error(`Missing synthetic medicine ${id}`)
    return item
  })
  const fever = catalog.diagnoses.find(item => item.code === 'R50.9')!
  const influenza = catalog.diagnoses.find(item => item.id === 'diagnosis-influenza')!
  expect(influenza.code).toBe('J10.1')
  expect(medications[0]!.allowedCombinationIds).toContain(medications[1]!.id)
  expect(medications[1]!.allowedCombinationIds).toContain(medications[0]!.id)
  await openWorkspaceTab(page, '诊断')
  await page.getByRole('button', { name: '添加诊断', exact: true }).click()
  const diagnosis = page.getByRole('dialog', { name: '选择诊断', exact: true })
  await diagnosis.getByRole('button', { name: `选择 ${fever.nameZh} ${fever.code}`, exact: true }).click()
  await diagnosis.getByRole('button', { name: '加入诊断', exact: true }).click()
  await diagnosis.getByRole('button', { name: '完成选择', exact: true }).click()
  await page.getByRole('region', { name: '待确认诊断', exact: true }).getByRole('button', { name: /^确认选中诊断/ }).click()
  await expect(page.getByRole('region', { name: '诊断列表', exact: true })).toBeVisible()
  await openWorkspaceTab(page, '处方')
  const pending = page.getByRole('region', { name: '待开具处方', exact: true })
  await step('01 · 门诊医生：同一弹窗连续加入两种药品，逐药核对用法用量')
  await page.getByRole('button', { name: '添加药品', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '选择药品', exact: true })
  for (const [index, medication] of medications.entries()) {
    await composer.getByRole('button', { name: `选择 ${medication.nameZh}`, exact: true }).click()
    await expect(composer.getByLabel('剂量', { exact: true })).toContainText(medication.defaultDoseText)
    await composer.getByRole('button', { name: '加入处方', exact: true }).click()
    await expect(composer).toBeVisible()
    await expect(composer.getByText(`待开具 ${index + 1} 项`, { exact: true })).toBeVisible()
  }
  await step('02 · 同窗已准备两种药品，可回看编辑，各行用法独立保留')
  const pendingRows = page.getByRole('region', { name: '处方待开清单', exact: true })
  const editor = page.getByRole('dialog', { name: '编辑药品', exact: true })
  const changedDose = medications[0]!.allowedDoseTexts.find(dose => dose !== medications[0]!.defaultDoseText)
  if (changedDose === undefined) throw new Error('The synthetic first medicine needs a second allowed dose')
  await pendingRows.getByRole('button', { name: /^编辑待开药品 / }).first().click()
  await editor.getByLabel('剂量', { exact: true }).click()
  await page.getByRole('option', { name: changedDose, exact: true }).click()
  await pendingRows.getByRole('button', { name: /^编辑待开药品 / }).nth(1).click()
  await expect(editor.getByLabel('剂量', { exact: true })).toContainText(medications[1]!.defaultDoseText)
  await pendingRows.getByRole('button', { name: /^编辑待开药品 / }).first().click()
  await expect(editor.getByLabel('剂量', { exact: true })).toContainText(changedDose)
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  const reopen = async () => {
    await page.reload()
    await openQueue(page)
    await page.getByRole('tab', { name: '在诊', exact: true }).click()
    await page.getByRole('button', { name: /^选择病例 / }).click()
    await closeQueue(page)
    await openWorkspaceTab(page, '处方')
    await expect(pending.getByRole('checkbox')).toHaveCount(2)
  }
  await step('03 · 关闭及刷新保留两药；清空选择保留草稿，再全选核对')
  await reopen()
  await page.getByRole('button', { name: '添加药品', exact: true }).click()
  await pendingRows.getByRole('button', { name: /^编辑待开药品 / }).first().click()
  await expect(editor.getByLabel('剂量', { exact: true })).toContainText(changedDose)
  await editor.getByRole('button', { name: '保存修改', exact: true }).click()
  await pending.getByRole('button', { name: '清空选择', exact: true }).click()
  await expect(pending.getByRole('button', { name: /^开具处方/ })).toBeDisabled()
  await expect(pending.getByRole('checkbox')).toHaveCount(2)
  await pending.getByRole('button', { name: '全选可办理项目', exact: true }).click()
  await step('04 · 一药适应症不符，整张处方拒绝；两行及全部输入保留')
  await pending.getByRole('button', { name: /^开具处方/ }).click()
  await expect(pending.getByText('已确认的诊断不在该药品允许的目录范围内。请调整诊断或更换药品。', { exact: true })).toBeVisible()
  expect((await readCase()).medicationConclusion?.prescription).toBeUndefined()
  await expect(pending.getByRole('checkbox')).toHaveCount(2)
  const before = await readCase()
  const changed = await page.request.post(`${browserApp.origin}/api/his/v1/doctor/cases/${consultationCase.outpatientCaseId}/recommendations/diagnosis/actions/confirm`, {
    headers: { origin: browserApp.origin, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    data: confirmDoctorPreparationRequestSchema.parse({ expectedVersions: { [`Encounter/${before.encounter.id}`]: before.encounter.versionId },
      input: { expectedDraftVersion: before.diagnosis?.draftVersion ?? 0,
        selections: [{ kind: 'diagnosis', source: 'manual', catalogItemId: influenza.id, role: 'primary', note: '合成复核：流感伴呼吸道表现。' }] } }),
  })
  expect(changed.status(), await changed.text()).toBe(200)
  expect(confirmDoctorPreparationResponseSchema.parse(await changed.json()).data.kind).toBe('diagnosis')
  await step('05 · 公开诊断操作复核流感后，刷新核对原两药，重新确认整张处方')
  await reopen()
  expect((await readCase()).diagnosis?.confirmation?.entries[0]?.catalogItemId).toBe(influenza.id)
  let dropped = false
  await page.route('**/recommendations/prescription/actions/confirm', async route => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    dropped = true
    await route.abort('failed')
  })
  await pending.getByRole('button', { name: /^开具处方/ }).click()
  await expect.poll(() => dropped).toBe(true)
  await expect(pending.getByText('原开立结果待恢复', { exact: true })).toBeVisible()
  await expect(pending.getByRole('button', { name: '恢复原开立', exact: true })).toBeEnabled()
  expect(posts).toHaveLength(2)
  await step('06 · 整单已生效但响应丢失；刷新读取原回执，不重发成功处方')
  await page.unroute('**/recommendations/prescription/actions/confirm')
  await page.reload()
  await openQueue(page)
  await page.getByRole('tab', { name: '在诊', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await closeQueue(page)
  await openWorkspaceTab(page, '处方')
  await pending.getByRole('button', { name: '恢复原开立', exact: true }).click()
  await expect(pending.getByText('原开立结果待恢复', { exact: true })).toHaveCount(0)
  await expect(pending.getByRole('checkbox')).toHaveCount(0)
  expect(posts).toHaveLength(2)
  expect(receiptReads).toHaveLength(1)
  expect(receiptReads[0]).toContain(posts[1]!.key)
  const final = await readCase()
  expect(final.medicationConclusion?.prescription?.items.map(item => item.catalogItemId)).toEqual(medications.map(item => item.id))
  expect(final.medicationConclusion?.prescription?.status).toBe('signed')
  const records = page.getByRole('region', { name: '药品列表', exact: true })
  for (const medication of medications) await expect(records.getByRole('cell', { name: medication.nameZh, exact: true })).toBeVisible()
  await step('07 · 一张正式处方含两种药品；原回执恢复完成，无重复开具')
  expect(errors).toEqual([])
  return { posts: posts.length, receiptReads: receiptReads.length, originalKey: posts[1]!.key,
    prescription: final.medicationConclusion!.prescription!, pageErrors: errors }
}
