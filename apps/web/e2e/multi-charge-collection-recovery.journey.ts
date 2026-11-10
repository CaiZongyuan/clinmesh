import { multiChargePaymentResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { expect, type Locator, type Page } from '@playwright/test'
import { startConsultationCase } from '../../server/tests/fixtures/consultation.ts'
import { openBillingDetails, readBill } from './billing-payments.fixture.ts'
import { prepareFourChargeCollection } from './multi-charge-collection.journey.ts'
import { issueDoctorLaboratoryRequest, readDoctorBillingCase, type startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { multiChargeDialog, previewSelectedCharges } from './multi-charge-payment.journey.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

type BillingServer = Awaited<ReturnType<typeof startInvestigationBillingServer>>

async function chooseCharge(page: Page, category: string, chargeId: string) {
  await page.getByRole('combobox', { name: '费用类别', exact: true }).click()
  await page.getByRole('option', { name: category, exact: true }).click()
  await page.locator(`[data-agent-selection="${chargeId}"]`).click()
}

/** 真正提交后仅丢弃浏览器响应；Surface 的代理路由仍指向同一真实临时服务。 */
export async function loseMultiChargeResponse(page: Page, origin: string, action: 'confirm' | 'recover') {
  let posts = 0, originalKey = ''
  let finish!: (value: ReturnType<typeof multiChargePaymentResponseSchema.parse>['data']) => void
  const committed = new Promise<ReturnType<typeof multiChargePaymentResponseSchema.parse>['data']>(resolve => { finish = resolve })
  const pattern = new RegExp(`/payments/[^/]+/actions/${action}-multi-charge$`)
  await page.route(pattern, async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    posts += 1
    originalKey = route.request().headers()['idempotency-key'] ?? ''
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `${origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
    expect(response.status()).toBe(200)
    const value = multiChargePaymentResponseSchema.parse(await response.json()).data
    await route.abort('failed')
    finish(value)
  })
  return { committed, posts: () => posts, originalKey: () => originalKey, dispose: () => page.unroute(pattern) }
}

export async function recoverSubmittedMultiCharge(page: Page, action: 'confirm' | 'recover', originalKey: string) {
  const receipt = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/his/v1/command-receipts')
      && url.searchParams.get('operationId') === `payment.multi-charge.${action}`
      && url.searchParams.get('idempotencyKey') === originalKey
  })
  await page.getByRole('button', { name: '查询原合并收款操作', exact: true }).click()
  const response = await receipt
  expect(response.status()).toBe(200)
  const lookup = commandReceiptLookupSchema.parse(await response.json())
  expect(lookup.status).toBe('completed')
  if (lookup.status !== 'completed') throw new Error('Missing original combined collection receipt')
  return multiChargePaymentResponseSchema.parse(lookup.response).data
}

/** 同一操作者恢复 A 的原回执时，B 已保存的双费私稿、金额和待缴筛选都保持原状。 */
export async function runCrossPatientCollectionRecovery(cashier: Page, doctor: Page, server: BillingServer, chargeIds: string[]) {
  const session = sessionContextSchema.parse(await (await cashier.request.get(`${server.origin}/api/auth/context`)).json())
  const original = await readBill(cashier, server)
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
  await issueDoctorLaboratoryRequest(doctor, { query: '白细胞', name: original.charges.find(charge => charge.category === 'laboratory')!.descriptionZh, code: '0100101A' })
  await doctor.getByRole('tab', { name: /^检验 \d+$/ }).click()
  await issueDoctorLaboratoryRequest(doctor, { query: '血红蛋白', name: '合成血红蛋白', code: '0100501A' })
  const secondTarget = { origin: server.origin, caseId: second.outpatientCaseId }
  const secondClinical = await readDoctorBillingCase(doctor, secondTarget)
  const secondBill = await readBill(cashier, secondTarget)
  const secondCharges = secondClinical.laboratoryRequests!.requests.map(request => request.billing!.chargeItemId)
  expect(secondCharges).toHaveLength(2)
  expect(secondBill.patient.id).not.toBe(original.patient.id)
  expect(secondBill.encounterId).not.toBe(original.encounterId)
  await cashier.getByRole('button', { name: '刷新账单', exact: true }).click()
  await chooseCharge(cashier, '检验费用', secondCharges[0]!)
  await cashier.getByRole('button', { name: '选择多项收费', exact: true }).click()
  const dialog = multiChargeDialog(cashier)
  await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
  await dialog.getByLabel('筛选费用', { exact: true }).fill('合成')
  await dialog.getByLabel('合成现金', { exact: true }).fill('8')
  await dialog.getByLabel('合成银行卡', { exact: true }).fill('8')
  await expect(dialog.getByRole('region', { name: '待处理清单', exact: true }).getByRole('listitem')).toHaveCount(2)
  await cashier.keyboard.press('Escape'); await expect(dialog).toBeHidden()
  const storedBefore = await cashier.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.includes('multi-charge-draft')))
  expect(storedBefore.length).toBeGreaterThan(0)

  const imaging = original.charges.find(charge => charge.category === 'imaging')!
  await chooseCharge(cashier, '放射费用', imaging.chargeItemId)
  const { preview } = await prepareFourChargeCollection(cashier, chargeIds)
  const loss = await loseMultiChargeResponse(cashier, server.origin, 'confirm')
  await dialog.getByRole('button', { name: '确认合并收款', exact: true }).click()
  const committed = await loss.committed
  expect(committed).toMatchObject({ caseId: server.caseId, amountFen: 29600, outcome: 'success' })
  await expect(dialog.getByText('原合并收款操作结果待查', { exact: true })).toBeVisible()
  const originalDraftKey = await cashier.evaluate(caseId => Object.entries(sessionStorage).find(([key, value]) =>
    key.includes('multi-charge-draft') && JSON.parse(value).binding.caseId === caseId)?.[0], server.caseId)
  expect(originalDraftKey).toBeDefined()
  await cashier.evaluate(key => sessionStorage.setItem(key!, '{broken-view-draft'), originalDraftKey)
  await cashier.keyboard.press('Escape'); await expect(dialog).toBeHidden()
  await cashier.getByRole('tab', { name: '待缴', exact: true }).click()
  await chooseCharge(cashier, '检验费用', secondCharges[0]!)
  const currentPatient = cashier.getByRole('region', { name: '当前收费患者', exact: true })
  await expect(currentPatient.getByRole('heading', { name: secondBill.patient.name, exact: true })).toBeVisible()
  await expect(cashier.getByRole('tab', { name: '待缴', exact: true })).toHaveAttribute('aria-selected', 'true')
  const recovered = await recoverSubmittedMultiCharge(cashier, 'confirm', loss.originalKey())
  expect(recovered.paymentId).toBe(committed.paymentId)
  await expect(cashier.getByRole('button', { name: '查询原合并收款操作', exact: true })).toHaveCount(0)
  await expect(currentPatient.getByRole('heading', { name: secondBill.patient.name, exact: true })).toBeVisible()
  await expect(currentPatient).not.toContainText(original.patient.name)
  await expect(cashier.getByRole('tab', { name: '待缴', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(cashier.getByText('合并收款成功', { exact: true })).toHaveCount(0)
  await cashier.getByRole('button', { name: '选择多项收费', exact: true }).click()
  await expect(dialog).toContainText(secondBill.patient.identifier)
  const selected = dialog.getByRole('region', { name: '待处理清单', exact: true })
  await expect(selected.getByRole('listitem')).toHaveCount(2)
  await expect(selected).toContainText('本次合计 ¥16.00')
  await expect(dialog.getByLabel('筛选费用', { exact: true })).toHaveValue('合成')
  await expect(dialog.getByLabel('合成现金', { exact: true })).toHaveValue('8')
  await expect(dialog.getByLabel('合成银行卡', { exact: true })).toHaveValue('8')
  await expect(dialog).not.toContainText('¥296.00')
  const storedAfter = await cashier.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.includes('multi-charge-draft')))
  for (const entry of storedBefore) expect(storedAfter).toContainEqual(entry)
  expect(storedAfter.some(([key]) => key === originalDraftKey)).toBe(false)
  expect(await readBill(cashier, secondTarget)).toEqual(secondBill)
  const unchanged = sessionContextSchema.parse(await (await cashier.request.get(`${server.origin}/api/auth/context`)).json())
  expect(unchanged.actor).toEqual(session.actor); expect(unchanged.user.id).toBe(session.user.id)
  await cashier.keyboard.press('Escape'); await expect(dialog).toBeHidden()
  await cashier.getByRole('tab', { name: '已缴', exact: true }).click()
  await chooseCharge(cashier, '放射费用', imaging.chargeItemId)
  await openBillingDetails(cashier, '支付尝试记录')
  await expect(cashier.getByRole('region', { name: '支付尝试记录', exact: true }).getByRole('list', { name: '原收款项目分配', exact: true }).getByRole('listitem')).toHaveCount(4)
  const after = await readBill(cashier, server)
  expect(after.payments).toHaveLength(1)
  expect(after.payments[0]?.paymentId).toBe(committed.paymentId)
  expect(loss.posts()).toBe(1)
  await loss.dispose()
  return { committed, recovered, preview, secondCaseId: secondTarget.caseId }
}

/** 整笔拒绝不改四费余额；整笔未知冻结四项，重载后只恢复原 paymentId。 */
export async function runDeclinedAndUnknownCollection(page: Page, server: BillingServer, chargeIds: string[], reviewUi: (stage: string, region: Locator) => Promise<void> = async () => {}) {
  const before = await readBill(page, server)
  const { dialog } = await prepareFourChargeCollection(page, chargeIds, reviewUi)
  await dialog.getByRole('combobox', { name: '支付处理结果', exact: true }).click()
  await page.getByRole('option', { name: '拒绝', exact: true }).click()
  const declinePreview = await previewSelectedCharges(page, dialog)
  const declinedResponse = page.waitForResponse(response => response.url().endsWith(`/payments/${declinePreview.previewId}/actions/confirm-multi-charge`))
  await dialog.getByRole('button', { name: '确认合并收款', exact: true }).click()
  const declined = multiChargePaymentResponseSchema.parse(await (await declinedResponse).json()).data
  expect(declined.outcome).toBe('declined')
  await expect(page.getByText('合并收款未成功', { exact: true })).toBeVisible()
  await reviewUi('collection-declined', page.getByRole('main'))
  const declinedBill = await readBill(page, server)
  for (const charge of before.charges.filter(item => chargeIds.includes(item.chargeItemId))) {
    expect(declinedBill.charges.find(item => item.chargeItemId === charge.chargeItemId)).toMatchObject({ paidFen: 0, remainingFen: charge.remainingFen })
  }
  if (!(await dialog.isVisible())) await page.getByRole('button', { name: '选择多项收费', exact: true }).click()
  await dialog.getByRole('combobox', { name: '支付处理结果', exact: true }).click()
  await page.getByRole('option', { name: '结果未知', exact: true }).click()
  const preview = await previewSelectedCharges(page, dialog)
  await reviewUi('unknown-collection-confirmation', dialog)
  const unknownResponse = page.waitForResponse(response => response.url().endsWith(`/payments/${preview.previewId}/actions/confirm-multi-charge`))
  await dialog.getByRole('button', { name: '确认合并收款', exact: true }).click()
  const unknown = multiChargePaymentResponseSchema.parse(await (await unknownResponse).json()).data
  expect(unknown.outcome).toBe('ambiguous')
  await expect(page.getByText('合并收款结果待确认', { exact: true })).toBeVisible()
  await reviewUi('collection-unknown', page.getByRole('main'))
  for (const id of chargeIds) expect((await readBill(page, server)).charges.find(charge => charge.chargeItemId === id)).toMatchObject({ status: 'ambiguous', paidFen: 0 })
  if (await dialog.isVisible()) { await page.keyboard.press('Escape'); await expect(dialog).toBeHidden() }
  await page.reload()
  await expect(page.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '结果未知', exact: true }).click()
  await openBillingDetails(page, '支付尝试记录')
  const history = page.getByRole('region', { name: '支付尝试记录', exact: true })
  await history.getByRole('button', { name: '查询原合并收款', exact: true }).click()
  const review = page.getByRole('region', { name: '查询原支付结果', exact: true })
  await reviewUi('collection-recovery', review)
  const loss = await loseMultiChargeResponse(page, server.origin, 'recover')
  await review.getByRole('button', { name: '查询原合并收款', exact: true }).click()
  const committed = await loss.committed
  expect(committed).toMatchObject({ paymentId: unknown.paymentId, outcome: 'success', amountFen: 29600 })
  await expect(page.getByRole('button', { name: '查询原合并收款操作', exact: true })).toBeVisible()
  await page.reload()
  const recovered = await recoverSubmittedMultiCharge(page, 'recover', loss.originalKey())
  expect(recovered.paymentId).toBe(unknown.paymentId)
  await expect(page.getByRole('button', { name: '查询原合并收款操作', exact: true })).toHaveCount(0)
  const after = await readBill(page, server)
  expect(after.payments).toHaveLength(2)
  expect(after.payments.map(item => item.paymentId).toSorted()).toEqual([declined.paymentId, unknown.paymentId].toSorted())
  for (const id of chargeIds) expect(after.charges.find(charge => charge.chargeItemId === id)).toMatchObject({ status: 'paid', remainingFen: 0 })
  await reviewUi('collection-recovered', page.getByRole('main'))
  expect(loss.posts()).toBe(1)
  await loss.dispose()
  return { declined, unknown, recovered }
}
