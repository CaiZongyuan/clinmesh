import { expect, test } from './fixtures.ts'
import { signInCashier } from './billing-payments.fixture.ts'
import { openDoctorFirstVisit, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { expectFourUnpaidCharges, prepareMultiChargeInvestigations, rejectClinicalMedia } from './multi-charge-payment.fixture.ts'
import { runFourChargeCollectionSuccess } from './multi-charge-collection.journey.ts'

test('cashier confirms one collection for four original charges across three categories', async ({ page, browser, webRoot }) => {
  test.setTimeout(120_000)
  const server = await startInvestigationBillingServer(webRoot, true)
  const cashierContext = await browser.newContext(), cashier = await cashierContext.newPage()
  const doctorMedia = await rejectClinicalMedia(page), cashierMedia = await rejectClinicalMedia(cashier)
  try {
    await openDoctorFirstVisit(page, server)
    const prepared = await prepareMultiChargeInvestigations(page, server)
    await signInCashier(cashier, server)
    await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
    await runFourChargeCollectionSuccess(cashier, server, prepared.chargeIds)
    expect(doctorMedia).toEqual([])
    expect(cashierMedia).toEqual([])
  } finally {
    await page.close()
    await cashierContext.close()
    await server.close()
  }
})
