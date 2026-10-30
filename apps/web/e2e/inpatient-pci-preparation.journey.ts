import { expect, type Page } from '@playwright/test'
import { inpatientDetailSchema, inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { pciCaseSourceResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { registrationQueueSchema } from '@clinmesh/contracts/his'
import { loginPciBrowser, type PciBrowserApp } from './inpatient-pci.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

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
  await expect(preparation).toContainText('患者档案已就绪，可办理入院')
  await expect(page.getByText('Active', { exact: true })).toBeVisible()

  await loginPciBrowser(page, app, 'registrar')
  await page.goto(`${app.origin}/registration`)
  await page.getByRole('button', { name: '住院', exact: true }).click()
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
  await page.getByLabel('目标床位').click()
  await page.getByRole('option', { name: /1床/ }).click()
  await page.getByRole('button', { name: '接诊并分床', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toContainText('住院病区 · 1床')
  await open('inpatient-doctor', admission.patientName)
  await page.getByLabel('诊断目录检索', { exact: true }).fill('I25.103')
  await page.getByRole('button', { name: '查询诊断', exact: true }).click()
  await page.getByLabel('住院诊断', { exact: true }).click()
  await page.getByRole('option', { name: '冠状动脉粥样硬化性心脏病', exact: true }).click()
  await page.getByLabel('主诊断入院病情', { exact: true }).click()
  await page.getByRole('option', { name: '1 · 有', exact: true }).click()
  await page.getByLabel('主诊断备注', { exact: true }).fill('本院确认固定合成冠心病')
  await page.getByRole('button', { name: '确认住院诊断', exact: true }).click()
  await expect(page.getByText('主诊断：冠状动脉粥样硬化性心脏病', { exact: true })).toBeVisible()
  await stage(page, "DRG 预分组")
  await expect(page.getByRole('region', { name: "按当前诊断和手术", exact: true })).toContainText('FR59')

  await stage(page, '检查检验')
  const labCatalog = await s.read('inpatient-doctor', '/api/his/v1/inpatient/investigation-catalog', inpatientInvestigationCatalogSchema)
  const laboratories = labCatalog.items.filter(item => item.id.startsWith('hospital-lab-pci-'))
  expect(laboratories).toHaveLength(9)
  await page.getByRole('button', { name: '搜索共享检验目录', exact: true }).click()
  await page.getByLabel('检验搜索词', { exact: true }).fill('hospital-lab-pci-')
  await page.getByRole('button', { name: '搜索检验', exact: true }).click()
  for (const item of laboratories) {
    await page.getByRole('region', { name: '院内检验', exact: true }).getByRole('button', { name: `选择${item.display}`, exact: true }).click()
    const issued = page.waitForResponse(response => response.url().endsWith(`${path}/investigations/issue`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '开立住院检查', exact: true }).click()
    expect((await issued).status()).toBe(200)
  }
  await open('ward-nurse', admission.patientName)
  await stage(page, '检查检验')
  for (let index = 0; index < 9; index++) {
    const sent = page.waitForResponse(response => response.url().endsWith(`${path}/investigations/send`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '校对并送检', exact: true }).first().click()
    expect((await sent).status()).toBe(200)
  }
  // Run the ordinary background worker after the nurse sends the requests, without manufacturing reports.
  await s.runtime.dispatchPending()
  await open('inpatient-doctor', admission.patientName)
  await stage(page, '检查检验')
  for (let index = 0; index < 9; index++) {
    const acknowledged = page.waitForResponse(response => response.url().endsWith(`${path}/investigations/acknowledge`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: "已阅", exact: true }).first().click()
    expect((await acknowledged).status()).toBe(200)
  }
  const reports = await s.read('inpatient-doctor', `${path}/investigations`, inpatientInvestigationsSchema)
  expect(reports.laboratoryRequests.every(item => item.report?.acknowledgement !== undefined)).toBe(true)

  await open('cashier', admission.patientName)
  await stage(page, '出院')
  const funding = page.getByRole('region', { name: '住院收退款', exact: true })
  await funding.getByLabel('现金金额（元）', { exact: true }).fill('50')
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
  await open('ward-nurse', admission.patientName)
  await stage(page, '手术')
  await page.getByLabel('手术记录说明', { exact: true }).fill('九项术前检验已阅，合成造影核对')
  await page.getByRole('button', { name: "术前核对", exact: true }).click()
  await open('inpatient-doctor', admission.patientName)
  await stage(page, '手术')
  await page.getByLabel('手术记录说明', { exact: true }).fill('合成冠脉造影知情同意')
  const consented = page.waitForResponse(response => response.url().endsWith(`${path}/surgeries/confirm-consent`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: "确认手术知情同意书已签", exact: true }).click()
  expect((await consented).status()).toBe(200)
  // These bounded PRN doses belong to the prepared, consented angiography, before its actual procedure is recorded.
  await executePciMedicationThroughPages(page, app, open, stay, ['heparin', 'iohexol'])
  await open('inpatient-doctor', admission.patientName)
  await stage(page, '手术')
  await page.getByLabel('手术记录说明', { exact: true }).fill('合成冠脉造影术中用药完成与实际执行')
  await page.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${angiography.coding.code} · ${angiography.coding.display}`, exact: true }).click()
  const executed = page.waitForResponse(response => response.url().endsWith(`${path}/surgeries/execute`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: '记录实际手术', exact: true }).click()
  expect((await executed).status()).toBe(200)
  expect((await s.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema)).executions.map(item => item.actualProcedure.id)).toContain(angiography.id)
  await expect(page.getByRole('tab', { name: '手术', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(`实际实施：${angiography.coding.code} · ${angiography.coding.display}`, { exact: true })).toBeVisible()
  await stage(page, '病案')
  await page.getByLabel('确认本次主操作', { exact: true }).click()
  await page.getByRole('option', { name: `${angiography.coding.code} · ${angiography.coding.display}`, exact: true }).click()
  await page.getByRole('button', { name: '提交首页修订', exact: true }).click()
  await expect.poll(async () => (await s.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema)).executions.length).toBe(1)
  await stage(page, '手术')
  await requestSurgery(page, procedure, '合成冠心病PCI支架计划')
  const surgery = await s.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema)
  const planned = surgery.requests.find(item => item.plannedProcedure.id === procedure.id)!
  await stage(page, "DRG 预分组")
  for (const materialId of ['stent', 'balloon', 'guidewire', 'guiding-catheter']) {
    const material = catalog.materials.find(item => item.id === `hospital-material-pci-${materialId}`)!
    await page.getByLabel('预留耗材', { exact: true }).click()
    await page.getByRole('option', { name: material.display, exact: true }).click()
    await page.getByLabel('关联手术计划', { exact: true }).click()
    await page.getByRole('option', { name: procedure.coding.display, exact: true }).click()
    await page.getByLabel('预留或释放理由', { exact: true }).fill('合成PCI院内耗材预留')
    await page.getByRole('button', { name: '审阅新增预留', exact: true }).click()
    await page.getByRole('region', { name: "确认耗材预留变更", exact: true }).getByRole('button', { name: '确认预留变更', exact: true }).click()
    await expect(page.getByRole('region', { name: '确认耗材预留变更', exact: true })).toHaveCount(0)
  }
  const reservations = await s.read('inpatient-doctor', `${path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(reservations.reservations).toHaveLength(4)
  expect((await s.read('inpatient-doctor', `${path}/clinical`, inpatientFullClinicalSchema)).charges.filter(item => item.kind === 'material')).toHaveLength(0)
  return { ...stay, requestId: planned.id, reservations: reservations.reservations }
}

async function requestSurgery(page: Page, procedure: { coding: { code: string; display: string } }, reason: string) {
  await page.getByLabel('计划术式', { exact: true }).click()
  await page.getByRole('option', { name: `${procedure.coding.code} · ${procedure.coding.display}`, exact: true }).click()
  await page.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-08-24T15:00')
  await page.getByLabel('手术申请理由', { exact: true }).fill(reason)
  await page.getByRole('button', { name: '申请手术', exact: true }).click()
  await expect(page.getByRole('region', { name: '住院手术', exact: true })).toContainText(reason)
}

export async function executePciMedicationThroughPages(page: Page, app: PciBrowserApp, open: OpenPciPatient,
  stay: { path: string }, suffixes: string[], surgeryExecutionId?: string) {
  const s = app.fixture
  const admission = (await s.read('inpatient-doctor', stay.path, inpatientDetailSchema)).admission
  const catalog = await s.read('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema)
  const ordersBefore = (await s.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)).orders.map(item => item.id)
  await open('inpatient-doctor', admission.patientName)
  await stage(page, '诊断医嘱')
  for (const suffix of suffixes) {
    const medication = catalog.medications.find(item => item.id === `medication-pci-${suffix}`)!
    await page.getByLabel('医嘱项目', { exact: true }).click()
    await page.getByRole('option', { name: medication.display, exact: true }).click()
    await page.getByLabel('医嘱时效', { exact: true }).click()
    await page.getByRole('option', { name: '临时', exact: true }).click()
    if (surgeryExecutionId) {
      await page.getByLabel('术后关联手术', { exact: true }).click()
      await page.getByRole('option', { name: /36.0700 ·/ }).click()
    }
    await page.getByRole('button', { name: "开立医嘱", exact: true }).click()
    await expect(page.getByText(`${medication.display} · 待校对`, { exact: true })).toBeVisible()
  }
  await open('ward-nurse', admission.patientName)
  await stage(page, '诊断医嘱')
  for (let index = 0; index < suffixes.length; index++) {
    const response = page.waitForResponse(value => value.url().endsWith('/orders/verify') && value.request().method() === 'POST')
    await page.getByRole('button', { name: '校对医嘱', exact: true }).first().click()
    expect((await response).status()).toBe(200)
  }
  await page.getByLabel('停嘱或按需执行理由', { exact: true }).fill('固定合成病例本次介入用药')
  for (const suffix of suffixes.filter(item => ['heparin', 'iohexol'].includes(item))) {
    const medication = catalog.medications.find(item => item.id === `medication-pci-${suffix}`)!
    const article = page.locator('article').filter({ hasText: `${medication.display} · 已校对` })
    await article.getByRole('button', { name: '按需给药', exact: true }).click()
    await expect(page.getByText(`${medication.display} · 待执行`, { exact: true })).toBeVisible()
  }
  await open('pharmacist', admission.patientName)
  for (let index = 0; index < suffixes.length; index++) {
    const response = page.waitForResponse(value => value.url().endsWith('/executions/dispense') && value.request().method() === 'POST')
    const actions = page.getByRole('region', { name: '当前操作', exact: true })
    await actions.getByRole('button', { name: '发药', exact: true }).click()
    await actions.getByRole('button', { name: '确认发药', exact: true }).click()
    expect((await response).status()).toBe(200)
  }
  await open('ward-nurse', admission.patientName)
  await stage(page, '诊断医嘱')
  for (let index = 0; index < suffixes.length; index++) {
    const response = page.waitForResponse(value => value.url().endsWith('/executions/administer') && value.request().method() === 'POST')
    await page.getByRole('button', { name: '给药', exact: true }).first().click()
    expect((await response).status()).toBe(200)
  }
  const clinical = await s.read('inpatient-doctor', `${stay.path}/clinical`, inpatientFullClinicalSchema)
  const newOrders = clinical.orders.filter(item => !ordersBefore.includes(item.id))
  expect(newOrders).toHaveLength(suffixes.length)
  expect(newOrders.map(item => item.catalogItemId).sort()).toEqual(suffixes.map(suffix => `medication-pci-${suffix}`).sort())
  if (surgeryExecutionId) expect(newOrders.every(item => item.surgeryExecutionId === surgeryExecutionId)).toBe(true)
  expect(clinical.executions.filter(item => newOrders.some(order => order.id === item.orderId)).every(item => item.status === 'completed')).toBe(true)
}
