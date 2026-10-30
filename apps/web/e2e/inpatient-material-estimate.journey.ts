import type { Page } from '@playwright/test'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { expect, openEstimatePatient, requestAngiography, type EstimateBrowserApp, type PendingEstimateBrowserApp } from './inpatient-material-estimate.fixture.ts'

/** 生产表单写入与公开读取断言由 standalone Web 和 React 18/19 Surface 共用。 */
export async function runMaterialEstimateJourney(page: Page, app: EstimateBrowserApp) {
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
  await page.getByRole('button', { name: /合成固定病组联合验收/ }).click()
  await page.getByRole('tab', { name: '手术', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: /预计理由/ })).toHaveValue(reason)
  await expect(panel.getByRole('textbox', { name: '工作稿说明', exact: true })).toHaveValue('整批确认前人工复核')
  expect(app.modelFeatures).toHaveLength(2)

  await panel.getByRole('button', { name: '重新预计，保留工作稿', exact: true }).click()
  await expect(panel.getByRole('region', { name: '新预计候选差异', exact: true })).toContainText('独立合成双根造影方案')
  await expect(panel.getByRole('textbox', { name: /预计理由/ })).toHaveValue(reason)
  expect(app.modelFeatures).toHaveLength(4)
  await panel.getByRole('textbox', { name: '工作稿说明', exact: true }).fill('重新预计后继续保留原材料并人工复核')
  await panel.getByRole('button', { name: '保留当前编辑并核对最新工作稿', exact: true }).click()
  await expect.poll(async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]?.draft).toMatchObject({
    analysisId: null, note: '重新预计后继续保留原材料并人工复核', items: [{ reason }],
  })
  expect(writes.filter(path => path.endsWith('/material-estimates/save'))).toHaveLength(2)
  await panel.getByText('查看本次预计模型请求与恢复', { exact: true }).click()
  const usage = panel.getByRole('region', { name: '本次住院模型用量', exact: true })
  await expect(usage.getByLabel('实际模型请求数', { exact: true })).toHaveText('4')
  await usage.getByRole('button', { name: '展开模型请求明细', exact: true }).click()
  await expect(usage.getByRole('table', { name: '本次住院模型请求明细', exact: true })).toContainText('第 2 轮预计核验')

  const estimate = (await app.fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!
  for (let index = 0; index < 31; index++) {
    const created = await app.fixture.request('inpatient-doctor', `${stay.path}/drg/reservations`, {
      encounterVersion: stay.encounterVersion, requestId: estimate.requestId,
      materialId: 'hospital-material-catheter', catalogVersion: 1, quantity: 1, reason: '合成历史逐项预留，整批审阅替换',
    })
    expect(created.status).toBe(200)
  }
  await page.reload()
  await page.getByRole('button', { name: /合成固定病组联合验收/ }).click()
  await page.getByRole('tab', { name: '手术', exact: true }).click()
  const active = panel.getByRole('region', { name: '本计划有效预留', exact: true })
  await expect(active.locator('p').filter({ hasText: 'v1' })).toHaveCount(31)
  await expect(panel.getByRole('textbox', { name: '工作稿说明', exact: true })).toHaveValue('重新预计后继续保留原材料并人工复核')
  await panel.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理', exact: true }).check()
  await panel.getByRole('button', { name: '确认整批预留', exact: true }).click()
  await expect(panel.getByRole('button', { name: '本版工作稿已确认', exact: true })).toBeDisabled()
  const reserved = await app.fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(reserved.reservations.filter(item => item.status === 'released')).toHaveLength(31)
  expect(reserved.reservations.filter(item => item.status === 'reserved')).toMatchObject([{ requestId: estimate.requestId,
    materialId: 'hospital-material-catheter', quantity: 2, priceFen: 5000, unit: '根', status: 'reserved' }])
  expect(writes.filter(path => path.endsWith('/material-estimates/confirm'))).toHaveLength(1)
  expect((await app.fixture.read('cashier', `${stay.path}/charges`, inpatientChargesSchema)).charges).toEqual([])
  await openEstimatePatient(page, app, 'ward-nurse')
  await expect(panel).toContainText('当前岗位或病案状态只允许查看')
  await expect(panel.getByRole('textbox')).toHaveCount(0)
  expect(errors).toEqual([])
}

export async function runMaterialEstimateDraftRecoveryJourney(page: Page, app: PendingEstimateBrowserApp) {
  const stay = await app.fixture.admitSyntheticCase(['I25.103'], 'bed-general-1')
  let releaseSave!: () => void
  const gate = new Promise<void>(resolve => { releaseSave = resolve })
  const revisions: number[] = []
  await page.route('**/material-estimates/save', async route => {
    revisions.push(route.request().postDataJSON().input.expectedDraftRevision)
    if (revisions.length === 1) await gate
    await route.continue()
  })
  try {
    await openEstimatePatient(page, app)
    await requestAngiography(page)
    const panel = page.getByRole('region', { name: '手术耗材预计', exact: true })
    await expect(panel).toContainText('AI 正在准备预计清单')
    const note = panel.getByRole('textbox', { name: '工作稿说明', exact: true })
    await note.fill('生成期间保留的人工说明')
    await expect.poll(() => revisions).toEqual([0])
    app.releaseGeneration()
    const read = () => app.fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)
    await expect.poll(async () => (await read()).estimates[0]?.draft?.revision).toBe(1)
    const conflict = page.waitForResponse(response => response.url().endsWith('/material-estimates/save') && response.request().method() === 'POST')
    releaseSave()
    expect((await conflict).status()).toBe(409)
    const review = panel.getByRole('button', { name: '保留当前编辑并核对最新工作稿', exact: true })
    await expect(review).toBeVisible()
    await expect(note).toHaveValue('生成期间保留的人工说明')
    await expect(panel.getByRole('button', { name: '保存工作稿', exact: true })).toBeDisabled()
    await review.click()
    await expect.poll(async () => (await read()).estimates[0]?.draft?.note).toBe('生成期间保留的人工说明')
    expect(revisions).toEqual([0, 1])
    await page.reload()
    await page.getByRole('button', { name: /合成固定病组联合验收/ }).click()
    await page.getByRole('tab', { name: '手术', exact: true }).click()
    await expect(note).toHaveValue('生成期间保留的人工说明')
    expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
    expect((await app.fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual([])
  } finally { releaseSave(); app.releaseGeneration() }
}
