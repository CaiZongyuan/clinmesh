import { sessionContextSchema } from '@clinmesh/contracts/his'
import { expect, type Page } from '@playwright/test'
import { startConsultationCase } from '../../server/tests/fixtures/consultation.ts'
import { readBill } from './billing-payments.fixture.ts'
import { issueDoctorLaboratoryRequest, readDoctorBillingCase, type startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { multiChargeDialog, previewSelectedCharges } from './multi-charge-payment.journey.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

type BillingServer = Awaited<ReturnType<typeof startInvestigationBillingServer>>
export const multiChargePaginationLaboratoryItems = ['777-3', '789-8', '787-2', '785-6', '786-4', '788-0', '4544-3', '751-8', '731-0']
  .map((loinc, index) => ({ loinc, code: `990000${index + 1}A`, display: `合成分页检验${index + 1}` }))
async function selectCategory(page: Page, name: string) {
  await page.getByRole('combobox', { name: '费用类别', exact: true }).click()
  await page.getByRole('option', { name, exact: true }).click()
}
async function openChargeCase(page: Page, category: string, chargeId: string) {
  await selectCategory(page, category)
  await page.locator(`[data-agent-selection="${chargeId}"]`).click()
  await page.getByRole('button', { name: '选择多项收费', exact: true }).click()
  return multiChargeDialog(page)
}

/** 第二合成患者只由公开 setup 准备待诊；每笔正式费用仍从医生页面开具。 */
export async function runMultiChargePatientJourney(cashier: Page, doctor: Page, server: BillingServer) {
  const session = sessionContextSchema.parse(await (await cashier.request.get(`${server.origin}/api/auth/context`)).json())
  const original = await readBill(cashier, server)
  const imaging = original.charges.find(charge => charge.category === 'imaging')!
  const laboratoryName = original.charges.find(charge => charge.category === 'laboratory')!.descriptionZh
  let dialog = await openChargeCase(cashier, '放射费用', imaging.chargeItemId)
  await expect(dialog.getByRole('region', { name: '待处理清单', exact: true }).getByRole('listitem')).toHaveCount(2)
  await dialog.getByLabel('合成现金', { exact: true }).fill('27')
  await dialog.getByLabel('合成银行卡', { exact: true }).fill('250')
  await cashier.keyboard.press('Escape'); await expect(dialog).toBeHidden()

  const second = await startConsultationCase(server.runtime, server.password, server.origin)
  await doctor.reload()
  await expect(doctor.getByRole('heading', { name: '门诊诊疗', exact: true })).toBeVisible()
  const rail = doctor.getByRole('button', { name: /^候诊队列 ·/ })
  if (await rail.isVisible()) await rail.click()
  await doctor.getByRole('tab', { name: '待诊', exact: true }).click()
  await doctor.getByRole('button', { name: /^选择病例 / }).click()
  await doctor.getByRole('button', { name: '开始首诊', exact: true }).click()
  if (await rail.isVisible()) await rail.click()
  await openWorkspaceTab(doctor, '检验检查')
  const firstRequest = await issueDoctorLaboratoryRequest(doctor, { query: '白细胞', name: laboratoryName, code: '0100101A' })
  await doctor.getByRole('tab', { name: /^检验 \d+$/ }).click()
  await issueDoctorLaboratoryRequest(doctor, { query: '血红蛋白', name: '合成血红蛋白', code: '0100501A' })
  const secondTarget = { origin: server.origin, caseId: second.outpatientCaseId }
  const secondClinical = await readDoctorBillingCase(doctor, secondTarget)
  const chargeId = secondClinical.laboratoryRequests!.requests.find(request => request.id === firstRequest)!.billing!.chargeItemId
  const secondBill = await readBill(cashier, secondTarget)
  expect(secondBill.patient.id).not.toBe(original.patient.id)
  expect(secondBill.encounterId).not.toBe(original.encounterId)
  const unchanged = sessionContextSchema.parse(await (await cashier.request.get(`${server.origin}/api/auth/context`)).json())
  expect(unchanged.actor).toEqual(session.actor)
  expect(unchanged.user.id).toBe(session.user.id)

  dialog = await openChargeCase(cashier, '检验费用', chargeId)
  const selected = dialog.getByRole('region', { name: '待处理清单', exact: true })
  await expect(dialog).toContainText(secondBill.patient.identifier)
  await expect(selected.getByRole('listitem')).toHaveCount(0)
  await expect(dialog.getByLabel('合成现金', { exact: true })).toHaveValue('')
  await expect(dialog.getByRole('checkbox', { name: '选择收费：胸片', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
  await dialog.getByLabel('合成现金', { exact: true }).fill('8')
  await dialog.getByLabel('合成银行卡', { exact: true }).fill('8')
  await cashier.keyboard.press('Escape'); await expect(dialog).toBeHidden()
  dialog = await openChargeCase(cashier, '放射费用', imaging.chargeItemId)
  await expect(dialog).toContainText(original.patient.identifier)
  await expect(selected.getByRole('listitem')).toHaveCount(2)
  await expect(selected).toContainText('胸片')
  await expect(selected).toContainText('乳腺切片病理会诊')
  await expect(dialog.getByLabel('合成现金', { exact: true })).toHaveValue('27')
  await expect(dialog.getByLabel('合成银行卡', { exact: true })).toHaveValue('250')
  await cashier.reload()
  await expect(cashier.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
  dialog = await openChargeCase(cashier, '放射费用', imaging.chargeItemId)
  await expect(dialog.getByLabel('合成现金', { exact: true })).toHaveValue('27')
  await expect(dialog.getByLabel('合成银行卡', { exact: true })).toHaveValue('250')
  await cashier.keyboard.press('Escape'); await expect(dialog).toBeHidden()
  dialog = await openChargeCase(cashier, '检验费用', chargeId)
  await expect(selected.getByRole('listitem')).toHaveCount(2)
  await expect(dialog.getByLabel('合成现金', { exact: true })).toHaveValue('8')
  await expect(dialog.getByLabel('合成银行卡', { exact: true })).toHaveValue('8')

  // 十一笔独立原申请构成跨页候选；有限功能旅程，不派发检查或模型。
  for (const item of multiChargePaginationLaboratoryItems) {
    await issueDoctorLaboratoryRequest(doctor, { query: item.display, name: item.display, code: item.code })
  }
  await dialog.getByRole('button', { name: '刷新账单', exact: true }).click()
  const pages = dialog.getByRole('navigation', { name: '费用清单分页', exact: true })
  await expect(pages).toContainText('1 / 2')
  await dialog.getByRole('button', { name: '清空选择', exact: true }).click()
  await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
  await expect(selected.getByRole('listitem')).toHaveCount(9)
  await pages.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(selected.getByRole('listitem')).toHaveCount(9)
  await expect(dialog.getByRole('region', { name: '完整费用清单', exact: true }).getByRole('checkbox')).toHaveCount(2)
  await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
  await expect(selected.getByRole('listitem')).toHaveCount(11)
  await cashier.reload()
  await expect(cashier.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
  await cashier.getByRole('button', { name: '选择多项收费', exact: true }).click()
  await expect(pages).toContainText('2 / 2')
  await expect(selected.getByRole('listitem')).toHaveCount(11)
  await dialog.getByLabel('合成现金', { exact: true }).clear()
  await dialog.getByLabel('合成银行卡', { exact: true }).clear()
  const preview = await previewSelectedCharges(cashier, dialog)
  expect(preview.amountFen).toBe(8800)
  expect(preview.charges).toHaveLength(11)
  expect(new Set(preview.charges.map(charge => charge.chargeItemId)).size).toBe(11)
  expect((await readBill(cashier, secondTarget)).payments).toEqual([])
  await cashier.keyboard.press('Escape'); await expect(dialog).toBeHidden()
}
