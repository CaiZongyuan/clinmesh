import { libraryTest as test } from './cross-patient-queue.fixture.ts'
import { runPatientLibraryQueueJourney, runPatientLibraryRecoveryJourney } from './cross-patient-queue.journey.ts'

test('三位真实Brief就绪患者逐个确认起诊，具名下一位不会提前POST', async ({ page, browserApp }) => {
  await runPatientLibraryQueueJourney(page, browserApp)
})

test('起诊已提交但丢响应，刷新查询原回执不重发，冻结下一位失效不补位', async ({ page, browserApp }) => {
  await runPatientLibraryRecoveryJourney(page, browserApp)
})
