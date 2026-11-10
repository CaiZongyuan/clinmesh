import { expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { runRecordQueueJourney } from '../../../web/e2e/cross-patient-queue.journey.ts'
import { runInsuranceQueuePaginationJourney } from '../../../web/e2e/inpatient-insurance-queue.journey.ts'
import { observeQueuePage } from '../../../web/e2e/cross-patient-queue.fixture.ts'
import { buildQueueSurface, openQueueSurface, reviewQueueAppearance } from './cross-patient-queue.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`跨患者住院队列 React ${version} Surface`, () => {
  let script: string
  test.beforeAll(async () => { test.setTimeout(120_000); script = await buildQueueSurface(version) })
  test('病案逐份审核归档，具名下一份只切换并在窄宽放大深色可达', async ({ page, browserApp }, info) => {
    let stage = 0
    await runRecordQueueJourney(page, browserApp, {
      open: () => openQueueSurface(page, browserApp.origin, script, '/inpatient'),
      stage: () => reviewQueueAppearance(page, info, `react${version}-record-${stage++}`),
    })
  })
  test('医保12份真实归档病案保持10加2读取，下一份和跨页均显式继续', async ({ page, browserApp }, info) => {
    test.setTimeout(120_000)
    const observer = await observeQueuePage(page)
    let stage = 0
    await runInsuranceQueuePaginationJourney(page, browserApp, () => openQueueSurface(page, browserApp.origin, script, '/inpatient'), () => reviewQueueAppearance(page, info, `react${version}-payer-${stage++}`))
    observer.assertClean()
    await expect(page.getByRole('heading', { name: '本页暂无待核定病案', exact: true })).toBeVisible()
  })
})
