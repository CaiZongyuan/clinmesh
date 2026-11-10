import { expect, test as base } from './fixtures.ts'
import { createInvestigationSendBatchApp, prepareInvestigationSendBatchPatient, runInvestigationSendBatchJourney } from './inpatient-investigation-send-batch.journey.ts'

const test = base.extend({ browserApp: async ({ webRoot }, use) => {
  const app = await createInvestigationSendBatchApp(webRoot)
  try { await use(app) } finally { await app.close() }
} })

test('护士同患者集中送检保留标本与草稿，未知恢复只处理原项后重新核对余项', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const s = await prepareInvestigationSendBatchPatient(page, browserApp)
  const evidence = await runInvestigationSendBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/inpatient`) })
  expect(evidence).toMatchObject({ posts: 3, sent: 3, reports: 0, charges: 0 })
  expect(errors).toEqual([])
})
