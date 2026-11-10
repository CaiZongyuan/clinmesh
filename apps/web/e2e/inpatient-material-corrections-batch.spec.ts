import { test, expect } from './inpatient-drg.fixture.ts'
import { prepareMaterialCorrectionsBatchPatient, runMaterialCorrectionsBatchJourney } from './inpatient-material-corrections-batch.journey.ts'

test('术后双笔连续更正保留私稿，丢响应恢复原回执且不重复冲正', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const s = await prepareMaterialCorrectionsBatchPatient(page, browserApp)
  const result = await runMaterialCorrectionsBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/inpatient`) })
  expect(result).toMatchObject({ posts: 2, audits: 2, chargesFen: 200000, historyCount: 3 })
  expect(errors).toEqual([])
})
