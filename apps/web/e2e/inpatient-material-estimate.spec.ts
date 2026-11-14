import { selectInpatientStage } from './inpatient-ui.ts'
import { runMaterialEstimateDraftRecoveryJourney, runMaterialEstimateJourney } from './inpatient-material-estimate.journey.ts'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { expect, test, openEstimatePatient, requestAngiography } from './inpatient-material-estimate.fixture.ts'

test('保存冠脉计划自动预计、手改自动保存与刷新恢复，重新预计不覆盖工作稿，单次整批确认预留', async ({ page, estimateApp: app }) => {
  test.setTimeout(120_000)
  await runMaterialEstimateJourney(page, app)
})

test('首次生成抢先保存后保留人工输入，核对新稿可保存并刷新恢复', async ({ page, pendingEstimateApp: app }) => {
  await runMaterialEstimateDraftRecoveryJourney(page, app)
})

test('模型结果未知显示原尝试恢复入口，刷新与只读浏览均不重新派发或创建预留', async ({ page, unknownEstimateApp: app }) => {
  const stay = await app.fixture.admitSyntheticCase(['I25.103'], 'bed-general-1')
  await openEstimatePatient(page, app)
  await requestAngiography(page)
  const panel = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect(panel).toContainText('助手这次未能预填耗材，请直接填写。')
  await expect(page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认手术耗材', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: '查看原因', exact: true }).click()
  const usageDialog = page.getByRole('dialog', { name: '本次住院 AI 用量', exact: true })
  const usage = usageDialog.getByRole('region', { name: '本次住院AI用量', exact: true })
  await expect(usage.getByLabel('实际AI请求数', { exact: true })).toHaveText('1')
  await expect(usage).toContainText('结果未知 1')
  await usageDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: /合成固定病组联合验收/ }).click()
  await selectInpatientStage(page, '手术')
  await expect(panel).toContainText('助手这次未能预填耗材，请直接填写。')
  await openEstimatePatient(page, app, 'ward-nurse')
  await expect(panel).toHaveCount(0)
  expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation'])
  expect((await app.fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual([])
})
