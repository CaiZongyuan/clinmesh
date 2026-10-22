import { paymentResponseSchema } from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'
import { expectBillingFits, readBill, signInCashier, startBillingBrowserServer, submitPayment } from './billing-payments.fixture.ts'
import { refundCaseSchema, refundResponseSchema } from '@clinmesh/contracts/refunds'

test('cashier records a fee correction and recovers the same partial refund after refresh', async ({ page, webRoot }) => {
  const server = await startBillingBrowserServer(webRoot)
  try {
    await signInCashier(page, server)
    await submitPayment(page)
    const panel = page.getByRole('region', { name: '费用更正与退款', exact: true })
    await panel.getByLabel('费用冲减金额（元）', { exact: true }).fill('20')
    await panel.getByLabel('费用更正原因', { exact: true }).fill('合成费用录入错误，核准冲减20元。')
    await panel.getByRole('button', { name: '记录费用更正', exact: true }).click()
    const adjustmentReview = page.getByRole('alertdialog', { name: '确认费用更正', exact: true })
    await adjustmentReview.getByRole('button', { name: '确认费用更正', exact: true }).click()
    await expect(adjustmentReview).toHaveCount(0)
    await expect(panel).toContainText('¥20.00')
    await panel.getByLabel('本次退款金额（元）', { exact: true }).fill('10')
    await panel.getByLabel('退款处理结果', { exact: true }).click()
    await page.getByRole('option', { name: '结果未知', exact: true }).click()
    await panel.getByRole('button', { name: '预览退款', exact: true }).click()
    const review = page.getByRole('alertdialog', { name: '确认退款', exact: true })
    await expect(review).toContainText('¥10.00')
    const received = page.waitForResponse(response => response.request().method() === 'POST' && /\/refunds\/[^/]+\/actions\/confirm$/.test(new URL(response.url()).pathname))
    await review.getByRole('button', { name: '提交退款', exact: true }).click()
    const result = refundResponseSchema.parse(await (await received).json()).data
    expect(result.outcome).toBe('ambiguous')
    await page.reload()
    await page.getByRole('tab', { name: '已缴', exact: true }).click()
    await expect(panel).toContainText(result.refundId)
    await panel.getByRole('button', { name: '查询原退款结果', exact: true }).click()
    const recoveryReview = page.getByRole('alertdialog', { name: '查询原退款结果', exact: true })
    await recoveryReview.getByRole('button', { name: '查询原退款结果', exact: true }).click()
    await expect(recoveryReview).toHaveCount(0)
    const response = await page.request.get(`${server.origin}/api/his/v1/billing/cases/${server.caseId}/refunds`)
    const ledger = refundCaseSchema.parse(await response.json())
    expect(ledger).toMatchObject({ adjustedFen: 2000, refundedFen: 1000, reservedFen: 0, refunds: [{ refundId: result.refundId, outcome: 'success' }] })
    expect((await readBill(page, server)).charges.find(charge => charge.chargeItemId === server.chargeItemId)).toMatchObject({ amountFen: 4800, paidFen: 5800, remainingFen: 0 })
    await expectBillingFits(page)
  } finally { await server.close() }
})

test('collects installments and combined tenders, then recovers the original unknown attempt after refresh', async ({ page, webRoot }) => {
  const server = await startBillingBrowserServer(webRoot)
  try {
    await signInCashier(page, server)
    const initial = await readBill(page, server)
    const registration = initial.charges.find(charge => charge.category === 'registration')!
    expect(registration.remainingFen).toBeGreaterThan(0)
    await expectBillingFits(page)
    await page.getByLabel('合成现金', { exact: true }).fill('20')
    expect((await submitPayment(page)).outcome).toBe('success')
    await expect.poll(async () => (await readBill(page, server)).paidFen).toBe(2000)
    await expect(page.getByRole('tab', { name: '待缴', exact: true })).toHaveAttribute('aria-selected', 'true')

    await page.getByLabel('合成银行卡', { exact: true }).fill('10')
    await page.getByLabel('合成移动支付', { exact: true }).fill('8')
    expect((await submitPayment(page)).outcome).toBe('success')
    const combined = await readBill(page, server)
    expect(combined.payments.find(payment => payment.amountFen === 1800)?.tenders).toEqual([
      { method: 'bank-card', amountFen: 1000 }, { method: 'mobile', amountFen: 800 },
    ])
    expect(combined.charges.find(charge => charge.chargeItemId === server.chargeItemId)).toMatchObject({ paidFen: 3800, remainingFen: 3000 })

    await page.getByLabel('支付处理结果', { exact: true }).click()
    await page.getByRole('option', { name: '结果未知', exact: true }).click()
    const unknown = await submitPayment(page)
    expect(unknown).toMatchObject({ amountFen: 3000, outcome: 'ambiguous' })
    await expect(page.getByRole('tab', { name: '结果未知', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.reload()
    await page.getByRole('tab', { name: '结果未知', exact: true }).click()
    const bill = page.getByRole('region', { name: '本次就诊账单', exact: true })
    await expect(bill.getByText(`原支付尝试: ${unknown.paymentId}`, { exact: false })).toBeVisible()
    await expectBillingFits(page)

    await bill.getByRole('button', { name: '查询原支付结果', exact: true }).click()
    const review = page.getByRole('alertdialog', { name: '查询原支付结果', exact: true })
    await expect(review).toContainText(unknown.paymentId)
    await expect(review).toContainText('¥30.00')
    expect((await readBill(page, server)).payments).toHaveLength(3)
    await review.getByRole('button', { name: '取消', exact: true }).click()
    expect((await readBill(page, server)).payments.find(payment => payment.paymentId === unknown.paymentId)?.outcome).toBe('ambiguous')
    await bill.getByRole('button', { name: '查询原支付结果', exact: true }).click()
    const recovered = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith(`/payments/${unknown.paymentId}/actions/recover`))
    await review.getByRole('button', { name: '查询原支付结果', exact: true }).click()
    const recovery = await recovered
    expect(recovery.status()).toBe(200)
    expect(paymentResponseSchema.parse(await recovery.json()).data).toMatchObject({ paymentId: unknown.paymentId, outcome: 'success' })
    await expect(review).toHaveCount(0)
    const final = await readBill(page, server)
    expect(final.payments).toHaveLength(3)
    expect(final.payments.map(payment => payment.paymentId).sort()).toEqual([...combined.payments.map(payment => payment.paymentId), unknown.paymentId].sort())
    expect(final.payments.find(payment => payment.paymentId === unknown.paymentId)).toMatchObject({ initialOutcome: 'ambiguous', outcome: 'success' })
    expect(final.charges.find(charge => charge.chargeItemId === server.chargeItemId)).toMatchObject({ paidFen: 6800, remainingFen: 0 })
    expect(final.remainingFen).toBe(registration.remainingFen)
    await expect(page.getByRole('tab', { name: '已缴', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(bill).toBeVisible()
    await expect(bill).toContainText('原结果未知')
    await expectBillingFits(page)
  } finally { await server.close() }
})
