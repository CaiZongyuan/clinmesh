import { test, runOutpatientDiagnosisBatchJourney } from './outpatient-diagnosis-batch.fixture.ts'

for (const width of [1600, 390]) test(`两诊断连续加入、主次调整、整组冲突与刷新后原确认恢复 ${width}px`, async ({ page, browserApp, consultationCase }) => {
  await page.setViewportSize({ width, height: 1000 })
  await runOutpatientDiagnosisBatchJourney({ page, browserApp, consultationCase })
})
