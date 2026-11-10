import { expect, type Locator, type Page } from '@playwright/test'
import { multiChargePaymentResponseSchema } from '@clinmesh/contracts/his'
import { openBillingDetails, readBill } from './billing-payments.fixture.ts'
import { multiChargeDialog, previewSelectedCharges } from './multi-charge-payment.journey.ts'

/** 真实医生已开具的四项原费用，在收费员文字工作区冻结一次完整组合支付。 */
export async function prepareFourChargeCollection(page: Page, chargeIds: string[], review: (stage: string, region: Locator) => Promise<void> = async () => {}) {
  await page.getByRole('button', { name: '选择多项收费', exact: true }).click()
  const dialog = multiChargeDialog(page)
  await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
  await expect(dialog.getByRole('region', { name: '待处理清单', exact: true }).getByRole('listitem')).toHaveCount(4)
  await dialog.getByLabel('合成现金', { exact: true }).fill('196')
  await dialog.getByLabel('合成银行卡', { exact: true }).fill('100')
  const preview = await previewSelectedCharges(page, dialog)
  expect(preview.amountFen).toBe(29600)
  expect(preview.charges.map(charge => charge.chargeItemId).toSorted()).toEqual(chargeIds.toSorted())
  expect(preview.tenders).toEqual([{ method: 'cash', amountFen: 19600 }, { method: 'bank-card', amountFen: 10000 }])
  await expect(dialog.getByRole('button', { name: '确认合并收款', exact: true })).toBeEnabled()
  await review('collection-confirmation', dialog)
  return { dialog, preview }
}

/** 一次确认产生一笔整款及四个原费用分配；不循环原单费用确认入口。 */
export async function runFourChargeCollectionSuccess(page: Page, server: { origin: string; caseId: string }, chargeIds: string[], review: (stage: string, region: Locator) => Promise<void> = async () => {}) {
  const before = await readBill(page, server)
  expect(before.payments).toEqual([])
  const posts: string[] = []
  const watch = (request: { method(): string; url(): string }) => {
    if (request.method() === 'POST' && /\/payments\/[^/]+\/actions\/confirm(?:-multi-charge)?$/.test(new URL(request.url()).pathname)) posts.push(request.url())
  }
  page.on('request', watch)
  try {
    const { dialog, preview } = await prepareFourChargeCollection(page, chargeIds, review)
    const received = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith(`/payments/${preview.previewId}/actions/confirm-multi-charge`))
    await dialog.getByRole('button', { name: '确认合并收款', exact: true }).click()
    const response = await received
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toEqual({
      expectedVersions: Object.fromEntries(preview.charges.map(charge => [`ChargeItem/${charge.chargeItemId}`, String(charge.chargeVersion)])),
      input: { commitToken: preview.commitToken },
    })
    const payment = multiChargePaymentResponseSchema.parse(await response.json()).data
    expect(payment).toMatchObject({ kind: 'multi-charge', amountFen: 29600, outcome: 'success', caseId: before.caseId,
      patientId: before.patient.id, encounterId: before.encounterId,
      tenders: [{ method: 'cash', amountFen: 19600 }, { method: 'bank-card', amountFen: 10000 }] })
    expect(payment.allocations.map(item => item.chargeItemId).toSorted()).toEqual(chargeIds.toSorted())
    expect(payment.allocations.map(item => item.amountFen).toSorted((a, b) => a - b)).toEqual([800, 800, 8000, 20000])
    for (const allocation of payment.allocations) expect(allocation.remainingFen).toBe(0)
    const after = await readBill(page, server)
    expect(after.payments).toHaveLength(1)
    expect(after.payments[0]).toMatchObject({ kind: 'multi-charge', paymentId: payment.paymentId, amountFen: 29600, outcome: 'success',
      allocations: payment.allocations.map(({ chargeItemId, amountFen }) => ({ chargeItemId, amountFen })) })
    expect(after.payments[0]).not.toHaveProperty('chargeItemId')
    expect(after.charges.filter(charge => chargeIds.includes(charge.chargeItemId)).map(charge => ({ paid: charge.paidFen, remaining: charge.remainingFen })))
      .toEqual(before.charges.filter(charge => chargeIds.includes(charge.chargeItemId)).map(charge => ({ paid: charge.remainingFen, remaining: 0 })))
    expect(after.charges.find(charge => charge.category === 'registration')).toEqual(before.charges.find(charge => charge.category === 'registration'))
    expect(posts).toHaveLength(1)
    if (await dialog.isVisible()) { await page.keyboard.press('Escape'); await expect(dialog).toBeHidden() }
    await openBillingDetails(page, '支付尝试记录')
    const history = page.getByRole('region', { name: '支付尝试记录', exact: true })
    await expect(history.getByText('¥296.00', { exact: true })).toHaveCount(1)
    for (const charge of preview.charges) await expect(history.getByText(charge.descriptionZh, { exact: true })).toHaveCount(1)
    return { payment, preview, before, after, confirmPosts: posts }
  } finally { page.off('request', watch) }
}
