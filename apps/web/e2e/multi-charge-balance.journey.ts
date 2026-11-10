import { insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { expect, type Page } from '@playwright/test'
import { openBillingDetails, readBill, submitPayment } from './billing-payments.fixture.ts'
import { readDoctorBillingCase, type startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { multiChargeDialog, previewSelectedCharges } from './multi-charge-payment.journey.ts'

type BillingServer = Pick<Awaited<ReturnType<typeof startInvestigationBillingServer>>, 'origin' | 'caseId'>

/** 另一真实收费员页面办理既有医保/单项分次款，主窗口必须撤销原冻结并重读逐项余额。 */
export async function runMultiChargeBalanceJourney(primary: Page, other: Page, doctor: Page, server: BillingServer, chargeIds: string[], requestIds: string[]) {
  const original = await readBill(primary, server)
  const imaging = original.charges.find(charge => charge.category === 'imaging' && chargeIds.includes(charge.chargeItemId))!
  await primary.getByRole('combobox', { name: '费用类别', exact: true }).click()
  await primary.getByRole('option', { name: '放射费用', exact: true }).click()
  await primary.getByRole('button', { name: '选择多项收费', exact: true }).click()
  const dialog = multiChargeDialog(primary), frozen = dialog.getByRole('region', { name: '合并收费预览', exact: true })
  await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
  expect((await previewSelectedCharges(primary, dialog)).amountFen).toBe(29600)
  await openBillingDetails(other, '医保待遇')
  const insurance = other.getByRole('region', { name: '患者医保待遇', exact: true })
  await insurance.getByRole('button', { name: '患者医保待遇（合成）', exact: true }).click()
  await insurance.getByLabel('固定合成方案', { exact: true }).click()
  await other.getByRole('option', { name: '合成职工 v1', exact: true }).click()
  await insurance.getByRole('button', { name: '预览医保待遇', exact: true }).click()
  await insurance.getByRole('button', { name: '审阅医保结算', exact: true }).click()
  const review = other.getByRole('alertdialog', { name: '确认医保结算', exact: true })
  const confirmed = other.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith(`/insurance/outpatient/${server.caseId}/confirm`))
  await review.getByRole('button', { name: '提交医保结算', exact: true }).click()
  const confirmation = await confirmed
  expect(confirmation.status()).toBe(200)
  insuranceResponseSchema.parse(await confirmation.json())
  await expect(review).toBeHidden()
  await dialog.getByRole('button', { name: '刷新账单', exact: true }).click()
  await expect(frozen).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: '待处理清单', exact: true })).toContainText('本次合计 ¥280.00')
  await expect(dialog.getByRole('region', { name: '待处理清单', exact: true }).getByRole('listitem')).toHaveCount(4)
  await expect(dialog.getByRole('button', { name: '预览合并收费', exact: true })).toBeDisabled()
  // 合成职工账户足以覆盖两项8元检验；已覆盖项须由操作者明确移除，不能静默漏项。
  for (const charge of original.charges.filter(charge => charge.category === 'laboratory' && chargeIds.includes(charge.chargeItemId))) {
    await dialog.getByRole('button', { name: `移除收费：${charge.descriptionZh}`, exact: true }).click()
  }
  const covered = await previewSelectedCharges(primary, dialog)
  expect(covered).toMatchObject({ totalFen: 28000, paidFen: 0, insuranceFen: 0, remainingFen: 28000, amountFen: 28000 })
  expect((await readBill(primary, server)).charges.filter(charge => charge.category === 'laboratory').map(charge => [charge.insuranceFen, charge.remainingFen])).toEqual([[800, 0], [800, 0]])
  await other.getByRole('combobox', { name: '费用类别', exact: true }).click()
  await other.getByRole('option', { name: '放射费用', exact: true }).click()
  await other.locator(`[data-agent-selection="${imaging.chargeItemId}"]`).click()
  await other.getByLabel('合成现金', { exact: true }).fill('3')
  const payment = await submitPayment(other)
  expect(payment).toMatchObject({ amountFen: 300, outcome: 'success', remainingFen: 7700 })
  await dialog.getByRole('button', { name: '刷新账单', exact: true }).click()
  await expect(frozen).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: '待处理清单', exact: true })).toContainText('本次合计 ¥277.00')
  const partial = await previewSelectedCharges(primary, dialog)
  expect(partial).toMatchObject({ totalFen: 28000, paidFen: 300, insuranceFen: 0, remainingFen: 27700, amountFen: 27700 })
  expect(partial.charges.find(charge => charge.chargeItemId === imaging.chargeItemId)).toMatchObject({ amountFen: 8000, paidFen: 300, insuranceFen: 0, remainingFen: 7700, collectionAmountFen: 7700 })
  const after = await readBill(primary, server)
  expect(after.payments).toHaveLength(original.payments.length + 1)
  expect(after.payments.find(attempt => attempt.paymentId === payment.paymentId)).toMatchObject({ chargeItemId: imaging.chargeItemId, amountFen: 300 })
  const clinical = await readDoctorBillingCase(doctor, server)
  const requests = [...clinical.laboratoryRequests!.requests, ...clinical.imagingRequests!.requests, ...clinical.pathologyRequests!.requests]
    .filter(request => requestIds.includes(request.id))
  expect(requests).toHaveLength(4)
  for (const request of requests) {
    expect(request.status).toBe('issued')
    expect(request.billing?.releasedAt).toBeUndefined()
    expect(request.report).toBeUndefined()
  }
  await primary.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  return { covered, partial, originalSinglePayment: payment }
}
