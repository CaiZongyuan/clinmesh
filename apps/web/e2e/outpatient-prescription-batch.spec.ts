import { test } from './outpatient-prescription-batch.fixture.ts'
import { runOutpatientPrescriptionBatchJourney } from './outpatient-prescription-batch.journey.ts'

for (const width of [1600, 390]) test(`两药连续添加、整单拒绝与刷新后原处方回执恢复 ${width}px`, async ({ page, browserApp, consultationCase }) => {
  await page.setViewportSize({ width, height: 1000 })
  await runOutpatientPrescriptionBatchJourney({ page, browserApp, consultationCase })
})
