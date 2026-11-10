import { expect, test } from './fixtures.ts'
import { signInCashier } from './billing-payments.fixture.ts'
import { openDoctorFirstVisit, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { expectFourUnpaidCharges, prepareMultiChargeInvestigations, rejectClinicalMedia } from './multi-charge-payment.fixture.ts'
import { clearMultiChargeDraftJourney, logoutMultiChargeDraftJourney, multiChargeDialog, recoverMultiChargePreviewJourney, runMultiChargePreviewJourney } from './multi-charge-payment.journey.ts'
import { runMultiChargeBalanceJourney } from './multi-charge-balance.journey.ts'

test('cashier restores multi-charge previews and drafts, invalidates changed balances and retains original single-charge partial payments', async ({ page, browser, webRoot }, testInfo) => {
  test.setTimeout(120_000)
  const server = await startInvestigationBillingServer(webRoot, true)
  const cashierContext = await browser.newContext()
  const cashier = await cashierContext.newPage()
  const otherContext = await browser.newContext(), other = await otherContext.newPage()
  const doctorMedia = await rejectClinicalMedia(page)
  const cashierMedia = await rejectClinicalMedia(cashier)
  const otherMedia = await rejectClinicalMedia(other)
  try {
    await openDoctorFirstVisit(page, server)
    const prepared = await prepareMultiChargeInvestigations(page, server)
    await signInCashier(cashier, server)
    const charges = await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
    await testInfo.attach('real-role-four-unpaid-charges', { contentType: 'application/json', body: JSON.stringify({ ...prepared, charges }) })
    await expect(cashier.getByRole('region', { name: '本次就诊账单', exact: true })).toBeVisible()
    const proof = await runMultiChargePreviewJourney(cashier, server, prepared.chargeIds)
    await testInfo.attach('selection-preview-proof', { contentType: 'application/json', body: JSON.stringify(proof) })
    await clearMultiChargeDraftJourney(multiChargeDialog(cashier))
    for (const mode of ['after-commit', 'before-send', 'corrupted-draft'] as const) await recoverMultiChargePreviewJourney(cashier, server, mode)
    for (const restricted of [false, true]) await logoutMultiChargeDraftJourney(cashier, server, restricted)
    await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
    await signInCashier(other, server)
    await runMultiChargeBalanceJourney(cashier, other, page, server, prepared.chargeIds, prepared.requestIds)
    expect(doctorMedia).toEqual([])
    expect(cashierMedia).toEqual([])
    expect(otherMedia).toEqual([])
  } finally {
    await otherContext.close()
    await cashierContext.close()
    await server.close()
  }
})
