import { test, expect } from './fixtures.ts'
import { openDoctorFirstVisit, startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { runInpatientExamination, runOutpatientExamination } from './examination.journey.ts'

test('无素材包真实门诊与住院完成ECG/TTE开单、收费送检与纯文本连续已阅', async ({ page, webRoot }, testInfo) => {
  test.setTimeout(120_000)
  const app = await startInvestigationBillingServer(webRoot, false, { normalCardiovascularBaseline: true })
  const errors: string[] = [],
    pixels: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route(/\/blocks\/|\/tiles\//, async (route) => {
    pixels.push(route.request().url())
    await route.abort('blockedbyclient')
  })
  try {
    await openDoctorFirstVisit(page, app)
    await runOutpatientExamination(page, app)
    await runInpatientExamination(page, app)
    await page.screenshot({ path: testInfo.outputPath('examination-text.png') })
    expect(errors).toEqual([])
    expect(pixels).toEqual([])
  } finally {
    await app.close()
  }
})
