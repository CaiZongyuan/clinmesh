import { test, expect } from './fixtures.ts'
import { startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { prepareOutpatientReportReader, runOutpatientReportReaderJourney } from './outpatient-report-reader.journey.ts'

test('门诊医生从真实三份签发报告进入同一连续阅读窗口，未打开报告不能选择已阅', async ({ page, webRoot }) => {
  const app = await startInvestigationBillingServer(webRoot, true, { includeCbc: true })
  try {
    await prepareOutpatientReportReader(page, app)
    await page.getByRole('button', { name: '连续阅读报告', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '报告阅读与已阅确认', exact: true })
    await expect(dialog).toBeVisible()
    const choices = dialog.getByRole('checkbox', { name: /^选择已阅：/ })
    await expect(choices).toHaveCount(3)
    for (const choice of await choices.all()) await expect(choice).toBeDisabled()
  } finally { await app.close() }
})

test('真实三份报告连续阅读后逐项已阅，刷新恢复原回执且剩余报告须重新阅读', async ({ page, webRoot }) => {
  test.setTimeout(120_000)
  const app = await startInvestigationBillingServer(webRoot, true, { includeCbc: true })
  const errors: string[] = [], pixels: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route(/\/blocks\/|\/tiles\//, async route => { pixels.push(new URL(route.request().url()).pathname); await route.abort('blockedbyclient') })
  try {
    const subject = await prepareOutpatientReportReader(page, app)
    await runOutpatientReportReaderJourney(page, subject)
    expect(errors).toEqual([])
    expect(pixels).toEqual([])
  } finally { await app.close() }
})
