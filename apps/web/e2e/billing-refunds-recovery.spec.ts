import { expect, test } from './fixtures.ts'
import { signInCashier, startBillingBrowserServer, submitPayment } from './billing-payments.fixture.ts'
import { verifyRefundWriteRecovery } from './billing-refunds-recovery.fixture.ts'

test('restores committed correction, refund and recovery receipts after lost responses and real refresh', async ({ page, webRoot }) => {
  const server = await startBillingBrowserServer(webRoot)
  try {
    await signInCashier(page, server)
    await submitPayment(page)
    await verifyRefundWriteRecovery(page, server, async () => {
      await page.reload()
      await page.getByRole('tab', { name: '已缴', exact: true }).click()
      await expect(page.getByRole('region', { name: '费用更正与退款', exact: true })).toBeVisible()
    })
  } finally { await server.close() }
})
