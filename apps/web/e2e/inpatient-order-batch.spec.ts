import { createDrgBrowserPatient, test } from './inpatient-drg.fixture.ts'
import { runInpatientOrderBatchJourney } from './inpatient-order-batch.journey.ts'

for (const width of [1600, 390]) test(`住院药品与护理多草稿集中开立，部分拒绝和丢响应刷新恢复不重复生效 ${width}px`, async ({ page, browserApp }) => {
  await page.setViewportSize({ width, height: 1000 })
  const subject = await createDrgBrowserPatient(page, browserApp, '合成多医嘱验收患者')
  await runInpatientOrderBatchJourney(page, browserApp, subject)
})
