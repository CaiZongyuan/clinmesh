import { test } from './fixtures.ts'
import { startInvestigationBillingServer } from './investigation-billing.fixture.ts'
import { prepareInpatientInvestigationActions, prepareOutpatientInvestigationCancel, runInpatientInvestigationCancelJourney, runOutpatientInvestigationCancelJourney } from './investigation-actions-batch.journey.ts'

test('门诊医生在真实检验入口选择同次就诊两项申请集中取消', async ({ page, webRoot }) => {
  const app = await startInvestigationBillingServer(webRoot)
  try {
    const subject = await prepareOutpatientInvestigationCancel(page, app)
    await runOutpatientInvestigationCancelJourney(page, subject)
  } finally {
    await app.close()
  }
})

test('门诊集中取消第二项丢响应即停止，刷新按原回执恢复后人工重审余项', async ({ page, webRoot }) => {
  const app = await startInvestigationBillingServer(webRoot, false, { includeCbc: true })
  try {
    const subject = await prepareOutpatientInvestigationCancel(page, app, 3)
    await runOutpatientInvestigationCancelJourney(page, subject, true)
  } finally {
    await app.close()
  }
})

test('住院医生从真实检查检验入口集中核对并取消两项待送检申请', async ({ page, webRoot }) => {
  const app = await startInvestigationBillingServer(webRoot)
  try {
    const patient = await prepareInpatientInvestigationActions(page, app)
    await runInpatientInvestigationCancelJourney(page, patient)
  } finally {
    await app.close()
  }
})
