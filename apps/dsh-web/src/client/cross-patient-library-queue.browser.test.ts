import { libraryTest as test } from '../../../web/e2e/cross-patient-queue.fixture.ts'
import { runPatientLibraryQueueJourney } from '../../../web/e2e/cross-patient-queue.journey.ts'
import { buildQueueSurface, openQueueSurface, reviewQueueAppearance } from './cross-patient-queue.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`患者库连续队列 React ${version} Surface`, () => {
  let script: string
  test.beforeAll(async () => { test.setTimeout(120_000); script = await buildQueueSurface(version) })
  test('三位Brief就绪患者分别确认，具名下一位不提前起诊且窄宽放大深色可达', async ({ page, browserApp }, info) => {
    let stage = 0
    await runPatientLibraryQueueJourney(page, browserApp, {
      open: () => openQueueSurface(page, browserApp.origin, script, '/scenario-data'),
      stage: () => reviewQueueAppearance(page, info, `react${version}-library-${stage++}`),
    })
  })
})
