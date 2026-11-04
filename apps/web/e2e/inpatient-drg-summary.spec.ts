import { test } from './inpatient-drg.fixture.ts'
import { runDrgSummaryJourney } from './inpatient-drg-summary.journey.ts'

test('病案与医保真实归档摘要按四格与两格排列，来源和人工审阅保持可达', async ({ page, browserApp }, info) => {
  await runDrgSummaryJourney(page, browserApp, info, { screenshots: true, mount: async () => { await page.goto(browserApp.origin + '/inpatient') } })
})
