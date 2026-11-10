import { expect, test } from './fixtures.ts'
import { signInCashier } from './billing-payments.fixture.ts'
import { openDoctorFirstVisit, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { expectFourUnpaidCharges, prepareMultiChargeInvestigations, rejectClinicalMedia } from './multi-charge-payment.fixture.ts'
import { runFourChargeCollectionSuccess } from './multi-charge-collection.journey.ts'
import { runMultiChargeAllocationRefund } from './multi-charge-allocation-refund.journey.ts'
import { runCrossPatientCollectionRecovery, runDeclinedAndUnknownCollection } from './multi-charge-collection-recovery.journey.ts'

for (const scenario of ['success-refund', 'unknown-recovery', 'cross-patient-recovery'] as const) test(`cashier combined collection ${scenario}`, async ({ page, browser, webRoot }) => {
  test.setTimeout(180_000)
  const server = await startInvestigationBillingServer(webRoot, true)
  const cashierContext = await browser.newContext(), cashier = await cashierContext.newPage()
  const doctorMedia = await rejectClinicalMedia(page), cashierMedia = await rejectClinicalMedia(cashier)
  const errors: string[] = []
  cashier.on('pageerror', error => errors.push(error.message))
  try {
    await openDoctorFirstVisit(page, server)
    const prepared = await prepareMultiChargeInvestigations(page, server)
    await signInCashier(cashier, server)
    await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
    if (scenario === 'success-refund') {
      const proof = await runFourChargeCollectionSuccess(cashier, server, prepared.chargeIds)
      await runMultiChargeAllocationRefund(cashier, page, server, proof.payment.paymentId)
    } else if (scenario === 'unknown-recovery') await runDeclinedAndUnknownCollection(cashier, server, prepared.chargeIds)
    else await runCrossPatientCollectionRecovery(cashier, page, server, prepared.chargeIds)
    expect(doctorMedia).toEqual([])
    expect(cashierMedia).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await page.close()
    await cashierContext.close()
    await server.close()
  }
})
