import { billingQueueSchema, paymentResponseSchema } from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'
import { expectBillingFits, readBill, signInCashier, submitPayment } from './billing-payments.fixture.ts'
import { issueDoctorLaboratoryRequest, openDoctorFirstVisit, readDoctorBillingCase, startInvestigationBillingServer } from './investigation-billing.fixture.ts'

test('collects the precise original charge for two doctor-issued laboratory requests in one visit', async ({ page, browser, webRoot }) => {
  const server = await startInvestigationBillingServer(webRoot)
  const cashierContext = await browser.newContext()
  const cashier = await cashierContext.newPage()
  try {
    await openDoctorFirstVisit(page, server)
    const firstId = await issueDoctorLaboratoryRequest(page, { query: '白细胞', name: '合成白细胞计数', code: '0100101A' })
    const secondId = await issueDoctorLaboratoryRequest(page, { query: '血红蛋白', name: '合成血红蛋白', code: '0100501A' })
    await server.runtime.dispatchPending()
    const requests = (await readDoctorBillingCase(page, server)).laboratoryRequests!.requests
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.status).toBe('issued')
      expect(request.report).toBeUndefined()
      expect(request.billing).toMatchObject({ status: 'pending', paidFen: 0, remainingFen: 800 })
    }
    const first = requests.find(request => request.id === firstId)!.billing!
    const second = requests.find(request => request.id === secondId)!.billing!
    expect(first.chargeItemId).not.toBe(second.chargeItemId)

    await signInCashier(cashier, server)
    const queueResponse = await cashier.request.get(`${server.origin}/api/his/v1/billing/queue?category=laboratory&status=pending`)
    const queue = billingQueueSchema.parse(await queueResponse.json())
    expect(queue.items.map(item => item.chargeItemId).sort()).toEqual([first.chargeItemId, second.chargeItemId].sort())
    await cashier.getByRole('listitem').filter({ hasText: '合成血红蛋白' }).click()
    await expect(cashier.getByText(`申请：${secondId}`, { exact: true })).toBeVisible()
    await cashier.getByLabel('合成现金', { exact: true }).fill('3')
    const previewed = cashier.waitForRequest(request => request.url().endsWith('/payments/actions/preview'))
    const paid = submitPayment(cashier)
    expect((await previewed).postDataJSON().input.chargeItemId).toBe(second.chargeItemId)
    expect((await paid).outcome).toBe('success')
    let bill = await readBill(cashier, server)
    expect(bill.charges.find(charge => charge.chargeItemId === first.chargeItemId)).toMatchObject({ paidFen: 0, remainingFen: 800 })
    expect(bill.charges.find(charge => charge.chargeItemId === second.chargeItemId)).toMatchObject({ paidFen: 300, remainingFen: 500 })
    expect((await submitPayment(cashier)).outcome).toBe('success')
    bill = await readBill(cashier, server)
    expect(bill.charges.find(charge => charge.chargeItemId === second.chargeItemId)).toMatchObject({ paidFen: 800, remainingFen: 0 })
    expect(bill.payments).toHaveLength(2)
    expect(bill.payments.every(payment => payment.chargeItemId === second.chargeItemId)).toBe(true)

    await cashier.getByRole('tab', { name: '待缴', exact: true }).click()
    await cashier.getByRole('listitem').filter({ hasText: '合成白细胞计数' }).click()
    await cashier.getByLabel('支付处理结果', { exact: true }).click()
    await cashier.getByRole('option', { name: '结果未知', exact: true }).click()
    const ambiguous = await submitPayment(cashier)
    expect(ambiguous.outcome).toBe('ambiguous')
    await cashier.reload()
    await cashier.getByRole('tab', { name: '结果未知', exact: true }).click()
    const original = cashier.getByRole('region', { name: '本次就诊账单', exact: true }).locator('div.rounded-md').filter({ hasText: ambiguous.paymentId })
    await original.getByRole('button', { name: '查询原支付结果', exact: true }).click()
    const review = cashier.getByRole('alertdialog', { name: '查询原支付结果', exact: true })
    const recovered = cashier.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/payments/${ambiguous.paymentId}/actions/recover`))
    await review.getByRole('button', { name: '查询原支付结果', exact: true }).click()
    expect(paymentResponseSchema.parse(await (await recovered).json()).data.outcome).toBe('success')
    bill = await readBill(cashier, server)
    expect(bill.payments).toHaveLength(3)
    expect(bill.payments.find(payment => payment.paymentId === ambiguous.paymentId)).toMatchObject({ chargeItemId: first.chargeItemId, outcome: 'success' })
    expect(bill.charges.find(charge => charge.chargeItemId === first.chargeItemId)).toMatchObject({ paidFen: 800, remainingFen: 0 })
    await expectBillingFits(cashier)
  } finally {
    await cashierContext.close()
    await server.close()
  }
})
