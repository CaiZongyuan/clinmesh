import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { billingCaseSchema, paymentPreviewResponseSchema, paymentResponseSchema } from '@clinmesh/contracts/his'
import { refundCaseSchema } from '@clinmesh/contracts/refunds'
import { readBill, startBillingBrowserServer, submitPayment } from '../../../web/e2e/billing-payments.fixture.ts'
import { buildNonDoctorCard, mountNonDoctorCard } from './non-doctor-card.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`billing cards on React ${version}`, () => {
  test.beforeAll(async () => { await buildNonDoctorCard(version) })
  test('submits the reviewed payment even after a different preview is prepared during the decision gate', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'cashier', { 'billing.payment.preview': {} })
      await expect(page.getByRole('list', { name: '办理流程', exact: true }).getByRole('listitem').filter({ hasText: '缴费' })).toHaveAttribute('aria-current', 'step')
      const cash = page.getByLabel('合成现金', { exact: true })
      await cash.fill('20')
      const firstResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/his/v1/payments/actions/preview')
      await page.getByRole('button', { name: '预览支付', exact: true }).click()
      const first = paymentPreviewResponseSchema.parse(await (await firstResponse).json()).data
      expect(first.amountFen).toBe(2000)
      await page.getByLabel('延迟批准', { exact: true }).check()
      await page.getByRole('button', { name: '助手准备收款', exact: true }).click()
      const review = page.getByRole('region', { name: '确认支付', exact: true })
      await expect(review).toContainText('¥20.00')
      await review.getByRole('button', { name: '提交支付', exact: true }).click()
      await expect(page.getByLabel('批准状态', { exact: true })).toHaveText('等待批准闸门')
      await cash.fill('30')
      const secondResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/his/v1/payments/actions/preview')
      await page.getByRole('button', { name: '助手填写 billing.payment.preview', exact: true }).click()
      const second = paymentPreviewResponseSchema.parse(await (await secondResponse).json()).data
      expect(second.amountFen).toBe(3000)
      expect(second.previewId).not.toBe(first.previewId)
      const received = page.waitForResponse(response => response.request().method() === 'POST' && /\/payments\/[^/]+\/actions\/confirm$/.test(new URL(response.url()).pathname))
      await page.getByRole('button', { name: '放行确认', exact: true }).click()
      const response = await received
      expect(new URL(response.url()).pathname).toContain(first.previewId)
      expect(response.status()).toBe(200)
      const payment = paymentResponseSchema.parse(await response.json()).data
      expect(payment.amountFen).toBe(2000)
      expect((await readBill(page, server)).paidFen).toBe(2000)
      await expect(cash).toHaveValue('30')
    } finally { await server.close() }
  })
  test('reports malformed and excessive tender amounts beside their fields before previewing', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'cashier')
      let previewRequests = 0
      page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/payments/actions/preview')) previewRequests += 1 })
      const cash = page.getByLabel('合成现金', { exact: true })
      await cash.fill('0.001')
      await expect(cash).toHaveAttribute('aria-invalid', 'true')
      await expect(page.getByText('请输入大于零、最多两位小数的金额，且合计不超过未收金额。', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '预览支付', exact: true })).toBeDisabled()
      await cash.fill('69')
      await expect(cash).toHaveAttribute('aria-invalid', 'true')
      expect(previewRequests).toBe(0)
      await cash.fill('20')
      await expect(cash).not.toHaveAttribute('aria-invalid', 'true')
      const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/payments/actions/preview'))
      await page.getByRole('button', { name: '预览支付', exact: true }).click()
      expect(paymentPreviewResponseSchema.parse(await (await response).json()).data.amountFen).toBe(2000)
    } finally { await server.close() }
  })
  test('retains unpaid corrections and fully refunded history independently of the visible payment page', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await mountNonDoctorCard(page, version, server, 'cashier')
      const panel = page.getByRole('region', { name: '费用更正与退款', exact: true })
      await expect(panel.getByLabel('费用冲减金额（元）', { exact: true })).toBeEnabled()
      await expect(page.getByRole('heading', { name: '退款', exact: true })).toHaveCount(0)
      expect((await submitPayment(page)).amountFen).toBe(6800)
      await expect(page.getByRole('heading', { name: '退款', exact: true })).toBeVisible()
      await panel.getByLabel('费用冲减金额（元）', { exact: true }).fill('68')
      await panel.getByLabel('费用更正原因', { exact: true }).fill('合成费用全部更正，核准冲减68元。')
      await panel.getByRole('button', { name: '记录费用更正', exact: true }).click()
      const correction = page.getByRole('region', { name: '确认费用更正', exact: true })
      await correction.getByRole('button', { name: '确认费用更正', exact: true }).click()
      await expect(correction).toHaveCount(0)
      await panel.getByLabel('本次退款金额（元）', { exact: true }).fill('68')
      await panel.getByRole('button', { name: '预览退款', exact: true }).click()
      const refund = page.getByRole('region', { name: '确认退款', exact: true })
      await refund.getByRole('button', { name: '确认退款', exact: true }).click()
      await expect(refund).toHaveCount(0)
      const ledger = refundCaseSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/billing/cases/${server.caseId}/refunds`)).json())
      expect(ledger.refundedFen).toBe(6800)
      const bill = await readBill(page, server)
      expect(bill.paidFen).toBe(0)
      // The page projection omits old attempts; the actual refund ledger and writes remain unchanged.
      await page.route(`**/api/his/v1/billing/cases/${server.caseId}?**`, route => route.fulfill({ json: billingCaseSchema.parse({
        ...bill, payments: [], paymentsPagination: { page: 1, pageSize: 20, total: 21 },
      }) }))
      await page.getByRole('button', { name: '刷新账单', exact: true }).click()
      await expect(page.getByRole('region', { name: '支付尝试记录', exact: true })).toContainText('尚无支付尝试')
      await expect(page.getByRole('heading', { name: '退款', exact: true })).toBeVisible()
      await expect(panel).toContainText(ledger.refunds[0]!.refundId)
      await expect(panel).toContainText('退款成功')
    } finally { await server.close() }
  })
})
