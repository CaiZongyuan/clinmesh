import { expect, test } from './fixtures.ts'
import { signInCashier } from './billing-payments.fixture.ts'
import { collectAndObserveInvestigationReports, issueBillableInvestigations } from './investigation-billing-execution.fixture.ts'
import { openDoctorFirstVisit, startInvestigationBillingServer } from './investigation-billing.fixture.ts'

test('collects three doctor-issued investigation fees and returns their original executed reports to the doctor', async ({ page, browser, webRoot }) => {
  test.setTimeout(120_000)
  const server = await startInvestigationBillingServer(webRoot, true)
  const context = await browser.newContext()
  const cashier = await context.newPage()
  const pixelRequests: string[] = []
  page.on('request', request => { if (request.url().includes('/blocks/')) pixelRequests.push(request.url()) })
  try {
    await openDoctorFirstVisit(page, server)
    const ids = await issueBillableInvestigations(page)
    await signInCashier(cashier, server)
    await collectAndObserveInvestigationReports(page, cashier, server, ids)
    expect(pixelRequests).toEqual([])
  } finally {
    await page.close()
    await context.close()
    await server.close()
  }
})
