import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { expect, test, openEstimatePatient, requestAngiography } from './inpatient-material-estimate.fixture.ts'

test('保存冠脉计划自动预计、手改自动保存与刷新恢复，重新预计不覆盖工作稿，单次整批确认预留', async ({ page, estimateApp: app }) => {
  test.setTimeout(120_000)
  const errors: string[] = [], writes: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
  const stay = await app.fixture.admitSyntheticCase(['I25.103'], 'bed-general-1')
  await openEstimatePatient(page, app)
  await requestAngiography(page)
  const panel = page.getByRole('region', { name: '手术耗材预计', exact: true })
  await expect(panel).toContainText('AI 预计与独立核验已完成')
  await expect(panel.getByRole('spinbutton', { name: /预计数量/ })).toHaveValue('2')
  await expect(panel).toContainText('¥100.00')
  expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  expect((await app.fixture.read('inpatient-doctor', `${stay.path}/drg/followup`, inpatientDrgFollowupSchema)).task).toBeNull()
  expect((await app.fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual([])

  const reason = '医生逐项核对双根导管，保留手工说明'
  await panel.getByRole('textbox', { name: /预计理由/ }).fill(reason)
  await panel.getByRole('textbox', { name: '工作稿说明', exact: true }).fill('整批确认前人工复核')
  await expect.poll(async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]?.draft?.note).toBe('整批确认前人工复核')
  expect(writes.filter(path => path.endsWith('/material-estimates/save'))).toHaveLength(1)
  await page.reload()
  await page.getByRole('tab', { name: '手术', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: /预计理由/ })).toHaveValue(reason)
  await expect(panel.getByRole('textbox', { name: '工作稿说明', exact: true })).toHaveValue('整批确认前人工复核')
  expect(app.modelFeatures).toHaveLength(2)

  await panel.getByRole('button', { name: '重新预计，保留工作稿', exact: true }).click()
  await expect(panel.getByRole('region', { name: '新预计候选差异', exact: true })).toContainText('独立合成双根造影方案')
  await expect(panel.getByRole('textbox', { name: /预计理由/ })).toHaveValue(reason)
  expect(app.modelFeatures).toHaveLength(4)
  await panel.getByText('查看本次预计模型请求与恢复', { exact: true }).click()
  const usage = panel.getByRole('region', { name: '本次住院模型用量', exact: true })
  await expect(usage.getByLabel('实际模型请求数', { exact: true })).toHaveText('4')
  await usage.getByRole('button', { name: '展开模型请求明细', exact: true }).click()
  await expect(usage.getByRole('table', { name: '本次住院模型请求明细', exact: true })).toContainText('第 2 轮预计核验')

  await panel.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理', exact: true }).check()
  await panel.getByRole('button', { name: '确认整批预留', exact: true }).click()
  await expect(panel.getByRole('button', { name: '本版工作稿已确认', exact: true })).toBeDisabled()
  const reserved = await app.fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(reserved.reservations).toMatchObject([{ requestId: (await app.fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!.requestId,
    materialId: 'hospital-material-catheter', quantity: 2, priceFen: 5000, unit: '根', status: 'reserved' }])
  expect(writes.filter(path => path.endsWith('/material-estimates/confirm'))).toHaveLength(1)
  expect((await app.fixture.read('cashier', `${stay.path}/charges`, inpatientChargesSchema)).charges).toEqual([])
  await openEstimatePatient(page, app, 'ward-nurse')
  await expect(panel).toContainText('当前岗位或病案状态只允许查看')
  await expect(panel.getByRole('textbox')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('模型结果未知显示原尝试恢复入口，刷新与只读浏览均不重新派发或创建预留', async ({ page, unknownEstimateApp: app }) => {
  const stay = await app.fixture.admitSyntheticCase(['I25.103'], 'bed-general-1')
  await openEstimatePatient(page, app)
  await requestAngiography(page)
  const panel = page.getByRole('region', { name: '手术耗材预计', exact: true })
  await expect(panel).toContainText('原模型请求结果未知')
  await expect(panel.getByRole('button', { name: '重新预计，保留工作稿', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '确认整批预留', exact: true })).toBeDisabled()
  await panel.getByText('查看本次预计模型请求与恢复', { exact: true }).click()
  const usage = panel.getByRole('region', { name: '本次住院模型用量', exact: true })
  await expect(usage.getByLabel('实际模型请求数', { exact: true })).toHaveText('1')
  await expect(usage).toContainText('结果未知 1')
  await page.reload()
  await page.getByRole('tab', { name: '手术', exact: true }).click()
  await expect(panel).toContainText('原模型请求结果未知')
  await openEstimatePatient(page, app, 'ward-nurse')
  await expect(panel).toContainText('原模型请求结果未知')
  expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation'])
  expect((await app.fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual([])
})
