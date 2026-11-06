import { selectInpatientStage } from './inpatient-ui.ts'
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
  const panel = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect(panel.getByRole('spinbutton', { name: /预计数量/ })).toHaveValue('2')
  await expect(panel).toContainText('¥100.00')
  await expect(panel).toContainText('独立合成双根造影方案')
  expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  expect((await app.fixture.read('inpatient-doctor', `${stay.path}/drg/followup`, inpatientDrgFollowupSchema)).task).toBeNull()
  expect((await app.fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations).toEqual([])

  await page.getByRole('region', { name: '当前住院患者', exact: true }).getByRole('button', { name: /本次住院 AI 用量/ }).click()
  const usageDialog = page.getByRole('dialog', { name: '本次住院 AI 用量', exact: true })
  const usage = usageDialog.getByRole('region', { name: '本次住院AI用量', exact: true })
  await expect(usage.getByLabel('实际AI请求数', { exact: true })).toHaveText('2')
  await usageDialog.getByRole('button', { name: '关闭', exact: true }).click()

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
  await selectInpatientStage(page, '手术')
  await expect(panel).toContainText('你 · 已确认')
  await panel.getByRole('button', { name: '修改', exact: true }).click()
  await panel.getByLabel('耗材清单说明', { exact: true }).fill('重新预计后继续保留原材料并人工复核')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认并预留', exact: true }).click()
  await expect(panel).toContainText('已为本计划预留 导管 2 · 预计 ¥100.00')
  const reserved = await app.fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(reserved.reservations.filter(item => item.status === 'released')).toHaveLength(31)
  expect(reserved.reservations.filter(item => item.status === 'reserved')).toMatchObject([{ requestId: estimate.requestId,
    materialId: 'hospital-material-catheter', quantity: 2, priceFen: 5000, unit: '根', status: 'reserved' }])
  expect(writes.filter(path => path.endsWith('/material-estimates/confirm'))).toHaveLength(1)
  expect((await app.fixture.read('cashier', `${stay.path}/charges`, inpatientChargesSchema)).charges).toEqual([])
  await openEstimatePatient(page, app, 'ward-nurse')
  await expect(page.getByRole('region', { name: '住院手术', exact: true })).toContainText('术前核对')
  await expect(panel).toHaveCount(0)
  expect(errors).toEqual([])
}

export async function runMaterialEstimateDraftRecoveryJourney(page: Page, app: PendingEstimateBrowserApp) {
  const stay = await app.fixture.admitSyntheticCase(['I25.103'], 'bed-general-1')
  try {
    await openEstimatePatient(page, app)
    await requestAngiography(page)
    const panel = page.getByRole('region', { name: '手术耗材', exact: true })
    await expect(panel).toContainText('助手正在按确认的选型参数生成指南参考并预填耗材')
    const note = panel.getByLabel('耗材清单说明', { exact: true })
    await note.fill('生成期间保留的人工说明')
    app.releaseGeneration()
    const read = () => app.fixture.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)
    await expect(panel).toContainText('独立合成双根造影方案')
    await expect(note).toHaveValue('生成期间保留的人工说明')
    await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认并预留', exact: true }).click()
    await expect(panel).toContainText('已为本计划预留')
    await expect.poll(async () => (await read()).estimates[0]?.draft?.note).toBe('生成期间保留的人工说明')
    await page.reload()
    await page.getByRole('button', { name: /合成固定病组联合验收/ }).click()
    await selectInpatientStage(page, '手术')
    await expect(panel).toContainText('已为本计划预留')
    expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  } finally {
    app.releaseGeneration()
    await page.unrouteAll({ behavior: 'wait' })
  }
}
