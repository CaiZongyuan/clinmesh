import { expect, type Page } from '@playwright/test'
import { inpatientDetailSchema, inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { pciCaseSourceResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { registrationQueueSchema } from '@clinmesh/contracts/his'
import { loginPciBrowser, type PciBrowserApp } from './inpatient-pci.fixture.ts'
import { acknowledgeInpatientCompletion, selectWorkspaceMode, selectInpatientStage } from './inpatient-ui.ts'
import { openExecutionBatch, recordOneActualExecution } from './inpatient-execution-batch.journey.ts'

export type OpenPciPatient = (role: string, patientName: string) => Promise<void>
const stage = selectInpatientStage

/** All clinical writes here originate in production forms; HTTP is only used to inspect their effects. */
export async function preparePciThroughPages(page: Page, app: PciBrowserApp, open: OpenPciPatient) {
  const s = app.fixture
  await loginPciBrowser(page, app, 'admin')
  await page.goto(`${app.origin}/scenario-data`)
  const preparation = page.getByRole('region', { name: 'PCI 演示准备', exact: true })
  await preparation.getByRole('button', { name: '准备 PCI 目录', exact: true }).click()
  await expect(preparation).toContainText('目录已准备')
  const sourceResponse = page.waitForResponse(response => response.url().endsWith('/synthetic-cases/pci/prepare') && response.request().method() === 'POST')
  await preparation.getByRole('button', { name: '准备固定 PCI 病例', exact: true }).click()
  const source = pciCaseSourceResponseSchema.parse(await (await sourceResponse).json()).data
  expect(source.case).toMatchObject({ status: 'brief-ready', activeBriefRevision: 1 })
  await expect(page.getByRole('tab', { name: '患者库', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: '演示准备', exact: true }).click()
  await expect(preparation).toContainText('患者档案已就绪，可办理入院')
  await page.getByRole('tab', { name: '患者库', exact: true }).click()
  await expect(page.getByText('当前使用', { exact: true })).toBeVisible()

  await loginPciBrowser(page, app, 'registrar')
  await page.goto(`${app.origin}/registration`)
  await selectWorkspaceMode(page, '住院')
  await page.getByLabel('患者来源', { exact: true }).click()
  await page.getByRole('option', { name: '就绪合成病例', exact: true }).click()
  await page.getByLabel('待住院合成病例', { exact: true }).click()
  await page.getByRole('option', { name: /合成冠脉病例甲/ }).click()
  await page.getByRole('button', { name: '办理住院', exact: true }).click()
  await expect(page.getByRole('heading', { name: '合成冠脉病例甲', exact: true })).toBeVisible()
  const admissions = await s.read('registrar', '/api/his/v1/inpatient/admissions', inpatientListSchema)
  expect(admissions.items).toHaveLength(1)
  const admission = admissions.items[0]!
  expect(admission).toMatchObject({ status: 'registered', admissionRoute: 'direct', depositFen: 0, chargesFen: 0 })
  expect((await s.read('registrar', '/api/his/v1/registrations', registrationQueueSchema)).items).toEqual([])
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await open('ward-nurse', admission.patientName)
  await page.getByRole('group', { name: '目标床位' }).getByRole('button', { name: /1床/ }).first().click()
  await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText('住院病区 · 1床')
  await open('inpatient-doctor', admission.patientName)
  await page.getByRole('button', { name: '添加诊断', exact: true }).click()
  const diagnosisDialog = page.getByRole('dialog', { name: '确认住院诊断', exact: true })
  await diagnosisDialog.getByLabel('搜索诊断名称或编码', { exact: true }).fill('I25.103')
  await diagnosisDialog.getByRole('button', { name: '加入冠状动脉粥样硬化性心脏病', exact: true }).click()
  await diagnosisDialog.getByRole('group', { name: '冠状动脉粥样硬化性心脏病 入院病情', exact: true }).getByRole('button', { name: '有', exact: true }).click()
  await diagnosisDialog.getByRole('button', { name: '加备注：冠状动脉粥样硬化性心脏病', exact: true }).click()
  await diagnosisDialog.getByLabel('冠状动脉粥样硬化性心脏病 备注', { exact: true }).fill('本院确认固定合成冠心病')
  await diagnosisDialog.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  await expect(page.getByRole('region', { name: '住院诊断摘要', exact: true }).locator('.clinmesh-inpatient-diagnosis-line').filter({ hasText: '冠状动脉粥样硬化性心脏病' })).toBeVisible()
  await stage(page, "DRG 预分组")
  await expect(page.getByRole('region', { name: "费用与支付参考", exact: true })).toContainText('FR59')

  await stage(page, '检查检验')
  const labCatalog = await s.read('inpatient-doctor', '/api/his/v1/inpatient/investigation-catalog', inpatientInvestigationCatalogSchema)
  const laboratories = labCatalog.items.filter(item => item.id.startsWith('hospital-lab-pci-'))
  expect(laboratories).toHaveLength(9)
  const composer = page.getByRole('dialog', { name: '开立住院检查', exact: true })
  for (const item of laboratories) {
    await page.getByRole('button', { name: '开立住院检查', exact: true }).click()
    await composer.getByLabel('搜索检查检验目录', { exact: true }).fill('hospital-lab-pci-')
    await composer.getByRole('button', { name: `选择${item.display}`, exact: true }).click()
    const issued = page.waitForResponse(response => response.url().endsWith(`${path}/investigations/issue`) && response.request().method() === 'POST')
    await composer.getByRole('button', { name: '开立所选检验（1）', exact: true }).click()
    expect((await issued).status()).toBe(200)
    await expect(composer.getByText(/已成功开立 \d+ 项/, { exact: true })).toBeVisible()
    await composer.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(composer).toHaveCount(0)
  }
  await open('ward-nurse', admission.patientName)
  await stage(page, '检查检验')
  await page.getByRole('button', { name: '全选本页可送检申请', exact: true }).click()
  await page.getByRole('button', { name: '集中送检', exact: true }).click()
  const dispatch = page.getByRole('dialog', { name: '集中送检核对', exact: true })
  await expect(dispatch.getByRole('article')).toHaveCount(9)
  await dispatch.getByRole('button', { name: '确认送检', exact: true }).click()
  await expect.poll(async () => (await s.read('ward-nurse', `${path}/investigations`, inpatientInvestigationsSchema)).sent.length).toBe(9)
  await expect(page.getByRole('region', { name: '送检逐项结果', exact: true })).toContainText(/成功\s*9|9\s*项成功/)
  // Run the ordinary background worker after the nurse sends the requests, without manufacturing reports.
  await s.runtime.dispatchPending()
  await open('inpatient-doctor', admission.patientName)
  await stage(page, '检查检验')
  await page.getByRole('button', { name: '连续阅读住院报告', exact: true }).click()
  const reader = page.getByRole('dialog', { name: '住院报告阅读与已阅确认', exact: true })
  for (const item of laboratories) {
    await reader.getByRole('button', { name: `打开报告：${item.display}`, exact: true }).click()
    await expect(reader.getByRole('article', { name: '当前报告全文', exact: true }).getByRole('table')).toBeVisible()
    await reader.getByRole('checkbox', { name: `选择已阅：${item.display}`, exact: true }).check()
  }
  await reader.getByRole('button', { name: '核对选中报告', exact: true }).click()
  const review = page.getByRole('dialog', { name: '住院报告已阅核对', exact: true })
  await expect(review.getByRole('article')).toHaveCount(9)
  const acknowledgements: number[] = []
  const receiveAcknowledgement = async (response: import('@playwright/test').Response) => {
    if (response.url().endsWith(`${path}/investigations/acknowledge`) && response.request().method() === 'POST') acknowledgements.push(response.status())
  }
  page.on('response', receiveAcknowledgement)
  await review.getByRole('button', { name: '确认选中报告已阅', exact: true }).click()
  await expect(reader.getByRole('region', { name: '报告已阅逐项结果', exact: true })).toContainText('本次办理已结束 · 成功 9/9')
  page.off('response', receiveAcknowledgement)
  expect(acknowledgements).toEqual(Array.from({ length: 9 }, () => 200))
  await reader.getByRole('button', { name: '关闭阅读窗口', exact: true }).click()
  const reports = await s.read('inpatient-doctor', `${path}/investigations`, inpatientInvestigationsSchema)
  expect(reports.laboratoryRequests.every(item => item.report?.acknowledgement !== undefined)).toBe(true)

  await open('cashier', admission.patientName)
  await stage(page, '出院')
  const funding = page.getByRole('region', { name: '住院收退款', exact: true })
  await funding.getByRole('button', { name: '补充预交金', exact: true }).click()
  await funding.getByLabel('收款金额（元）', { exact: true }).fill('50')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: "预览收款", exact: true }).click()
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: "确认收款", exact: true }).click()
  await expect(funding).toContainText('累计预交金：¥50.00')

  const catalog = await s.read('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema)
  const procedure = catalog.procedures.find(item => item.coding.code === '36.0700')!
  const stay = { admissionId: admission.id, patientId: admission.patientId, path,
    encounterVersion: (await s.read('inpatient-doctor', path, inpatientDetailSchema)).admission.versionId,
    sourceCaseId: source.case.caseId, sourceCaseRevision: source.case.revision, catalog, procedure }
  await executePciMedicationThroughPages(page, app, open, stay, ['aspirin', 'clopidogrel', 'atorvastatin'])
  const angiography = catalog.procedures.find(item => item.coding.code === '88.5500')!
  await open('inpatient-doctor', admission.patientName)
  await stage(page, '手术')
  await requestSurgery(page, angiography, '固定合成病例实际冠脉造影')
  const angiographyMaterials = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect(angiographyMaterials.getByRole('spinbutton', { name: '预计数量：合成演示导管', exact: true })).toHaveValue('1')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认手术耗材', exact: true }).click()
  await expect(angiographyMaterials).toContainText('你 · 已确认')
  await open('ward-nurse', admission.patientName)
  await stage(page, '手术')
  await page.getByLabel('术前核对说明', { exact: true }).fill('九项术前检验已阅，合成造影核对')
  await page.getByRole('button', { name: "术前核对", exact: true }).click()
  await open('inpatient-doctor', admission.patientName)
  await stage(page, '手术')
  await page.getByRole('button', { name: '确认已签', exact: true }).click()
  await page.getByLabel('签署说明', { exact: true }).fill('合成冠脉造影知情同意')
  const consented = page.waitForResponse(response => response.url().endsWith(`${path}/surgeries/confirm-consent`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: "确认手术知情同意书已签", exact: true }).click()
  expect((await consented).status()).toBe(200)
  // These bounded PRN doses belong to the prepared, consented angiography, before its actual procedure is recorded.
  await executePciMedicationThroughPages(page, app, open, stay, ['heparin', 'iohexol'])
  await open('inpatient-doctor', admission.patientName)
  await stage(page, '手术')
  await page.getByRole('button', { name: '整台补录', exact: true }).click()
  const batch = page.getByRole('dialog', { name: '整台补录', exact: true })
  await batch.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${angiography.coding.code} · ${angiography.coding.display}`, exact: true }).click()
  await batch.getByLabel('补录依据', { exact: true }).fill('合成冠脉造影术中用药完成与实际执行')
  const executed = page.waitForResponse(response => response.url().endsWith(`${path}/surgeries/execute`) && response.request().method() === 'POST')
  await batch.getByRole('button', { name: '记录实际手术', exact: true }).click()
  expect((await executed).status()).toBe(200)
  await s.runtime.dispatchPending()
  expect((await s.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema)).executions.map(item => item.actualProcedure.id)).toContain(angiography.id)
  await expect(page.getByRole('tab', { name: '手术', exact: true })).toHaveAttribute('aria-selected', 'true')
  const finalMaterials = page.getByRole('region', { name: '最终耗材', exact: true })
  await expect(finalMaterials).toContainText(angiography.coding.code)
  await expect(finalMaterials).toContainText(angiography.coding.display)
  await stage(page, '病案')
  await expect(page.getByRole('region', { name: '提交首页前', exact: true })).toContainText('出院结算后提交')
  await expect(page.getByRole('button', { name: '提交病案首页', exact: true })).toBeDisabled()
  await expect.poll(async () => (await s.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema)).executions.length).toBe(1)
  await stage(page, '手术')
  await requestSurgery(page, procedure, '合成冠心病PCI支架计划')
  await s.runtime.dispatchPending()
  const surgery = await s.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema)
  const planned = surgery.requests.find(item => item.plannedProcedure.id === procedure.id)!
  await expect(page.getByRole('region', { name: '选型参数', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确认选型参数', exact: true }).click()
  const stepTwo = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect(stepTwo).toBeVisible()
  const qtyInputs = stepTwo.getByRole('spinbutton', { name: /^预计数量：/ })
  await expect(qtyInputs).toHaveCount(4)
  for (const input of await qtyInputs.all()) {
    if ((await input.inputValue()) === '') await input.fill('1')
  }
  await page.getByRole('button', { name: '确认手术耗材', exact: true }).click()
  await expect(stepTwo).toContainText('已为本计划预留')
  const reservations = (await s.read('inpatient-doctor', `${path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations
  const pciReservations = reservations.filter(item => item.requestId === planned.id)
  expect(pciReservations).toHaveLength(4)
  expect(reservations.filter(item => item.requestId !== planned.id)).toEqual([expect.objectContaining({
    materialId: 'hospital-material-catheter', quantity: 1, consumedQuantity: 0, status: 'reserved',
  })])
  expect((await s.read('inpatient-doctor', `${path}/clinical`, inpatientFullClinicalSchema)).charges.filter(item => item.kind === 'material')).toHaveLength(0)
  return { ...stay, requestId: planned.id, reservations: pciReservations }
}

async function requestSurgery(page: Page, procedure: { coding: { code: string; display: string } }, reason: string) {
  await page.getByRole('button', { name: '申请手术', exact: true }).first().click()
  await page.getByLabel('计划术式', { exact: true }).click()
  await page.getByRole('option', { name: `${procedure.coding.code} · ${procedure.coding.display}`, exact: true }).click()
  await page.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-08-24T15:00')
  await page.getByLabel('手术申请理由', { exact: true }).fill(reason)
  await page.getByRole('button', { name: '提交手术申请', exact: true }).click()
  await expect(page.getByRole('region', { name: '住院手术', exact: true })).toContainText(reason)
}

export async function executePciMedicationThroughPages(page: Page, app: PciBrowserApp, open: OpenPciPatient,
  stay: { path: string }, suffixes: string[], surgeryExecutionId?: string) {
  const s = app.fixture
  const admission = (await s.read('inpatient-doctor', stay.path, inpatientDetailSchema)).admission
  const catalog = await s.read('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema)
  const ordersBefore = (await s.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)).orders.map(item => item.id)
  const acknowledgeCompleted = () => acknowledgeInpatientCompletion(page, `已完成本次操作 · ${admission.patientName}`)
  await open('inpatient-doctor', admission.patientName)
  await stage(page, '诊断医嘱')
  for (const suffix of suffixes) {
    const medication = catalog.medications.find(item => item.id === `medication-pci-${suffix}`)!
    await page.getByRole('button', { name: '开立医嘱', exact: true }).click()
    await page.getByLabel('医嘱项目', { exact: true }).fill(medication.display)
    await page.getByRole('region', { name: '医嘱项目候选', exact: true }).getByRole('button', { name: new RegExp(medication.display) }).click()
    await page.getByRole('group', { name: '医嘱时效', exact: true }).getByRole('button', { name: '临时', exact: true }).click()
    if (surgeryExecutionId) {
      await page.getByLabel('术后医嘱关联手术', { exact: true }).click()
      await page.getByRole('option', { name: /36.0700 ·/ }).click()
    }
    await page.getByRole('button', { name: '开立所选医嘱（1）', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '开立医嘱', exact: true }).getByText(`${medication.display} · 待护士校对`, { exact: true })).toBeVisible()
    await page.getByRole('dialog', { name: '开立医嘱', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.locator('article').filter({ hasText: medication.display }).filter({ hasText: '待校对' })).toBeVisible()
  }
  await open('ward-nurse', admission.patientName)
  await stage(page, '诊断医嘱')
  for (let index = 0; index < suffixes.length; index++) {
    const response = page.waitForResponse(value => value.url().endsWith('/orders/verify') && value.request().method() === 'POST')
    await page.getByRole('checkbox', { name: /^选择校对：/ }).first().check()
    await page.getByRole('button', { name: '集中核对新医嘱 (1)', exact: true }).click()
    await page.getByRole('dialog', { name: '集中核对新医嘱', exact: true }).getByRole('button', { name: '确认校对 1 条新医嘱', exact: true }).click()
    expect((await response).status()).toBe(200)
    await acknowledgeCompleted()
  }
  for (const suffix of suffixes.filter(item => ['heparin', 'iohexol'].includes(item))) {
    const medication = catalog.medications.find(item => item.id === `medication-pci-${suffix}`)!
    const order = (await s.read('ward-nurse', `${stay.path}/clinical`, inpatientFullClinicalSchema)).orders.find(item => item.catalogItemId === medication.id && !ordersBefore.includes(item.id))!
    const dialog = await openExecutionBatch(page, 'request-prn')
    await dialog.getByRole('article', { name: `PRN项目：${order.id}`, exact: true }).getByRole('checkbox', { name: `选择PRN：${medication.display}`, exact: true }).check()
    await dialog.getByRole('textbox', { name: 'PRN共同理由', exact: true }).fill('固定合成病例本次介入用药')
    await dialog.getByRole('button', { name: '核对 PRN 发起 (1)', exact: true }).click()
    await dialog.getByRole('button', { name: '确认发起 PRN', exact: true }).click()
    await expect(dialog.getByRole('region', { name: 'PRN逐项结果', exact: true })).toContainText('成功 1/1')
    await dialog.getByRole('button', { name: '关闭办理窗口', exact: true }).click()
    await expect(page.locator('article').filter({ hasText: medication.display }).filter({ hasText: '待执行' })).toBeVisible()
    await acknowledgeCompleted()
  }
  await open('pharmacist', admission.patientName)
  await page.getByRole('button', { name: '全选本页可发药执行单', exact: true }).click()
  await page.getByRole('button', { name: '集中发药', exact: true }).click()
  const dispensing = page.getByRole('dialog', { name: '集中发药核对', exact: true })
  await expect(dispensing.getByRole('article')).toHaveCount(suffixes.length)
  await dispensing.getByRole('button', { name: '确认发药', exact: true }).click()
  await expect.poll(async () => {
    const state = await s.read('pharmacist', `${stay.path}/pharmacy`, inpatientPharmacySchema)
    const current = state.orders.filter(item => !ordersBefore.includes(item.id))
    return state.executions.filter(item => current.some(order => order.id === item.orderId) && item.status === 'dispensed').length
  }).toBe(suffixes.length)
  await expect(page.getByRole('region', { name: '发药逐项结果', exact: true }).getByRole('heading', { name: `逐项发药结果 · 成功 ${suffixes.length}/${suffixes.length}`, exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /^已完成发药$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '恢复原发药', exact: true })).toHaveCount(0)
  await open('ward-nurse', admission.patientName)
  await stage(page, '诊断医嘱')
  for (let index = 0; index < suffixes.length; index++) {
    const response = page.waitForResponse(value => value.url().endsWith('/executions/administer') && value.request().method() === 'POST')
    await recordOneActualExecution(page, 'administer')
    expect((await response).status()).toBe(200)
    // 通过正常关闭本次完成提示，确认交接后连续处理下一条；不绕过全宽布局或指针命中。
    await acknowledgeCompleted()
  }
  const clinical = await s.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
  const newOrders = clinical.orders.filter(item => !ordersBefore.includes(item.id))
  expect(newOrders).toHaveLength(suffixes.length)
  expect(newOrders.map(item => item.catalogItemId).sort()).toEqual(suffixes.map(suffix => `medication-pci-${suffix}`).sort())
  if (surgeryExecutionId) expect(newOrders.every(item => item.surgeryExecutionId === surgeryExecutionId)).toBe(true)
  expect(clinical.executions.filter(item => newOrders.some(order => order.id === item.orderId)).every(item => item.status === 'completed')).toBe(true)
}
