import { test, expect } from './fixtures.ts'
import { startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { prepareInpatientReportReader, runInpatientReportReaderJourney } from './inpatient-report-reader.journey.ts'

test('住院医生从三份真实签发报告进入同一连续阅读窗口，未打开不能选择已阅', async ({ page, webRoot }) => {
  test.setTimeout(120_000)
  const app = await startInvestigationBillingServer(webRoot, true, { includeCbc: true })
  try {
    await prepareInpatientReportReader(page, app)
    await page.getByRole('button', { name: '连续阅读住院报告', exact: true }).click()
    const reader = page.getByRole('dialog', { name: '住院报告阅读与已阅确认', exact: true })
    await expect(reader).toBeVisible()
    const choices = reader.getByRole('checkbox', { name: /^选择已阅：/ })
    await expect(choices).toHaveCount(3)
    for (const choice of await choices.all()) await expect(choice).toBeDisabled()
  } finally { await app.close() }
})

test('住院三报告连续阅读、关闭清除阅读资格、丢响应刷新后只恢复原已阅再确认余项', async ({ page, webRoot }) => {
  test.setTimeout(120_000)
  const app = await startInvestigationBillingServer(webRoot, true, { includeCbc: true })
  try {
    const subject = await prepareInpatientReportReader(page, app)
    await runInpatientReportReaderJourney(page, subject)
  } finally { await app.close() }
})
