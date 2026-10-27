import { expect, test } from './fixtures.ts'
import { signInCashier } from './billing-payments.fixture.ts'
import { refundCancelledInvestigation } from './investigation-billing-cancellation.fixture.ts'
import { openDoctorFirstVisit, startInvestigationBillingServer } from './investigation-billing.fixture.ts'

for (const kind of ['imaging', 'pathology'] as const) {
  test(`refunds the original partial payment after the doctor cancels a ${kind} request`, async ({ page, browser, webRoot }) => {
    test.setTimeout(120_000)
    const server = await startInvestigationBillingServer(webRoot, true)
    const context = await browser.newContext()
    const cashier = await context.newPage()
    const pixelRequests: string[] = []
    page.on('request', request => { if (request.url().includes('/blocks/')) pixelRequests.push(request.url()) })
    try {
      await openDoctorFirstVisit(page, server)
      await signInCashier(cashier, server)
      await refundCancelledInvestigation(page, cashier, server, kind)
      expect(pixelRequests).toEqual([])
    } finally {
      await context.close()
      await server.close()
    }
  })
}
