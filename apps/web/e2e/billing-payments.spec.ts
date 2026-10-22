import { paymentResponseSchema } from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'
import { expectBillingFits, readBill, signInCashier, startBillingBrowserServer, submitPayment } from './billing-payments.fixture.ts'

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
