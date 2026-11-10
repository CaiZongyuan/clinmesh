import { expect, test } from './fixtures.ts'
import { signInCashier } from './billing-payments.fixture.ts'
import { openDoctorFirstVisit, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { expectFourUnpaidCharges, prepareMultiChargeInvestigations, rejectClinicalMedia } from './multi-charge-payment.fixture.ts'

test('cashier selects and previews four original doctor-issued charges across three categories without collecting money', async ({ page, browser, webRoot }, testInfo) => {
  test.setTimeout(120_000)
  const server = await startInvestigationBillingServer(webRoot, true)
  const cashierContext = await browser.newContext()
  const cashier = await cashierContext.newPage()
  const doctorMedia = await rejectClinicalMedia(page)
  const cashierMedia = await rejectClinicalMedia(cashier)
  try {
    await openDoctorFirstVisit(page, server)
    const prepared = await prepareMultiChargeInvestigations(page, server)
    await signInCashier(cashier, server)
    const charges = await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
    await testInfo.attach('real-role-four-unpaid-charges', { contentType: 'application/json', body: JSON.stringify({ ...prepared, charges }) })
    await expect(cashier.getByRole('region', { name: '本次就诊账单', exact: true })).toBeVisible()
    await cashier.getByRole('button', { name: '选择多项收费', exact: true }).click()
    const dialog = cashier.getByRole('dialog', { name: '选择多项收费', exact: true })
    await expect(dialog).toBeVisible()
    for (const charge of charges) {
      await dialog.getByRole('checkbox', { name: `选择收费：${charge.descriptionZh}`, exact: true }).check()
    }
    await dialog.getByRole('button', { name: '预览合并收费', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: '合并收费预览', exact: true })).toBeVisible()
    await expect(dialog).toContainText('本预览尚未收款')
    await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
    expect(doctorMedia).toEqual([])
    expect(cashierMedia).toEqual([])
  } finally {
    await cashierContext.close()
    await server.close()
  }
})
