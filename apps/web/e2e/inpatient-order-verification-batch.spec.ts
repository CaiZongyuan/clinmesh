import { expect, test } from './fixtures.ts'
import { prepareOrderVerificationBatchPatient, runOrderVerificationBatchJourney } from './inpatient-order-verification-batch.journey.ts'

test('护士集中校对新医嘱，刷新恢复私稿与原回执后重审余项且不混入核停或实际执行', async ({ page, browserApp }) => {
  const errors: string[] = [], pixelRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route(/\/(?:pixels|tiles|dicom)(?:\/|\?)/, async route => { pixelRequests.push(new URL(route.request().url()).pathname); await route.abort() })
  const s = await prepareOrderVerificationBatchPatient(page, browserApp)
  const result = await runOrderVerificationBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/inpatient`) })
  expect(result).toMatchObject({ posts: 3, audits: 3, verifiedOrders: 3, executionCount: 2, stopRequestedOrders: 1, chargesFen: 0 })
  expect(errors).toEqual([])
  expect(pixelRequests).toEqual([])
})
