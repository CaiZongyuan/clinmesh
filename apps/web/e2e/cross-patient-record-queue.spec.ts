import { test } from './inpatient-drg.fixture.ts'
import { runRecordQueueInvalidTargetJourney, runRecordQueueJourney } from './cross-patient-queue.journey.ts'

test('两份真实提交病案逐份审核归档，具名下一份只切换且不自动办理', async ({ page, browserApp }) => {
  await runRecordQueueJourney(page, browserApp)
})

test('审核已生效但响应丢失，刷新查询原回执恢复具名下一份且不重复审核', async ({ page, browserApp }) => {
  await runRecordQueueJourney(page, browserApp, { loseReviewResponse: true })
})

test('冻结的下一份被其他窗口审核后保留当前病案，不静默换成第三人', async ({ page, browserApp }) => {
  await runRecordQueueInvalidTargetJourney(page, browserApp)
})
