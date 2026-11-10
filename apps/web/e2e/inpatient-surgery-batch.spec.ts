import { test, expect } from './inpatient-drg.fixture.ts'
import { prepareSurgeryBatchPatient, runSurgeryBatchJourney, runSurgeryBatchConflictJourney } from './inpatient-surgery-batch.journey.ts'

test('同一患者连续双材整台补录、私稿刷新、余量全选清空及双回执恢复', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const s = await prepareSurgeryBatchPatient(page, browserApp)
  await runSurgeryBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/inpatient`) })
  expect(errors).toEqual([])
})

test('所选预留被另一操作释放后真实409保留整台私稿且没有部分费用', async ({ page, browserApp }) => {
  const s = await prepareSurgeryBatchPatient(page, browserApp)
  await runSurgeryBatchConflictJourney(page, s, async () => { await page.goto(`${browserApp.origin}/inpatient`) })
})
