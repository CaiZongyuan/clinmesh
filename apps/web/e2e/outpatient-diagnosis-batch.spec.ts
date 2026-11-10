import { test, runOutpatientDiagnosisBatchJourney } from './outpatient-diagnosis-batch.fixture.ts'

for (const width of [1600, 390]) test(`两诊断连续加入、主次调整、整组冲突与刷新后原确认恢复 ${width}px`, async ({ page, browserApp, consultationCase }) => {
  await page.setViewportSize({ width, height: 1000 })
  await runOutpatientDiagnosisBatchJourney({ page, browserApp, consultationCase })
})

test('主诊断被真实服务明确拒绝后解冻，保留备注供修正并用新键确认', async ({ page, browserApp, consultationCase }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await runOutpatientDiagnosisBatchJourney({ page, browserApp, consultationCase, rejection: 'primary' })
})
