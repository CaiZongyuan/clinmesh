import { expect, test } from './fixtures.ts'
import { readBill, signInCashier } from './billing-payments.fixture.ts'
import { openDoctorFirstVisit, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { expectFourUnpaidCharges, prepareMultiChargeInvestigations, rejectClinicalMedia } from './multi-charge-payment.fixture.ts'
import { multiChargeDialog, previewSelectedCharges } from './multi-charge-payment.journey.ts'

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
    await cashier.getByRole('button', { name: '选择多项收费', exact: true }).click()
    const dialog = multiChargeDialog(cashier)
    await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
    const preview = await previewSelectedCharges(cashier, dialog)
    expect(preview.amountFen).toBe(29600)
    expect(preview.charges.map(charge => charge.chargeItemId).toSorted()).toEqual(prepared.chargeIds.toSorted())
    expect((await readBill(cashier, server)).payments).toEqual([])
    await expect(dialog.getByRole('button', { name: '确认合并收款', exact: true })).toBeEnabled()
    expect(doctorMedia).toEqual([])
    expect(cashierMedia).toEqual([])
  } finally {
    await page.close()
    await cashierContext.close()
    await server.close()
  }
})
