import { expect, test } from './fixtures.ts'
import { prepareOrderStopBatchPatient, runOrderStopBatchJourney } from './inpatient-order-stop-batch.journey.ts'

test('医生集中申请停嘱保留逐项理由，护士独立核停并取消待执行而保留已发药费用', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const s = await prepareOrderStopBatchPatient(page, browserApp)
  const evidence = await runOrderStopBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/inpatient`) })
  expect(evidence).toMatchObject({ requestPosts: 2, verifyPosts: 2, stoppedOrders: 2, cancelledExecutions: 2,
    signedOrders: 1, dispenses: 1, charges: 1 })
  expect(errors).toEqual([])
})
