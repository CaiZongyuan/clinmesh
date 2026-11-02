import { selectInpatientStage } from './inpatient-ui.ts'
import { inpatientDrgFollowupResponseSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { expect, type Page } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientDrgAgentSchema, inpatientDrgAgentResponseSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { cancelAutomaticMaterialEstimate, pciAgentParameters } from '../../server/tests/fixtures/inpatient-drg-agent.ts'
import type { PciBrowserApp } from './inpatient-pci.fixture.ts'
import type { OpenPciPatient } from './inpatient-pci-preparation.journey.ts'

export async function prepareDrgAgentStay(app: PciBrowserApp) {
  const s = app.fixture, stay = await s.preparePciAdmission()
  await cancelAutomaticMaterialEstimate(s, stay)
  const selected = await s.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, { expectedVersion: 0, parameters: { ...pciAgentParameters, requestId: stay.requestId } })
  expect(selected.status).toBe(200)
  inpatientPciSelectionResponseSchema.parse(await selected.json())
  const admission = (await s.read('inpatient-doctor', stay.path, inpatientDetailSchema)).admission
  return { s, stay, admission }
}

async function generateDrgAgentStay(app: PciBrowserApp) {
  const prepared = await prepareDrgAgentStay(app)
  const { s, stay } = prepared
  const started = await s.request('inpatient-doctor', `${stay.path}/drg/followup/start`, {
    encounterVersion: stay.encounterVersion, expectedTaskVersion: 0,
  })
  expect(started.status).toBe(200)
  inpatientDrgFollowupResponseSchema.parse(await started.json())
  await expect.poll(async () => (await s.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)).status).toBe('succeeded')
  const generated = await s.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)
  return { ...prepared, generated }
}

export async function runDrgAgentJourney(page: Page, app: PciBrowserApp, open: OpenPciPatient) {
  const { s, stay, admission } = await prepareDrgAgentStay(app)
  await open('inpatient-doctor', admission.patientName)
  await selectInpatientStage(page, "DRG 预分组")
  const region = page.getByRole('region', { name: '住院耗材建议', exact: true })
  await page.getByRole('button', { name: '开启本次住院跟进', exact: true }).click()
  await expect(region.getByText("AI分析与核验已完成", { exact: true })).toBeVisible()
  await expect(region.getByText(/synthetic-drg-model/)).toBeVisible()
  await expect(region.getByRole('article').filter({ hasText: 'hospital-material-pci-stent v1' }).getByText(/医生确认本次合成单病变计划一枚支架/)).toBeVisible()
  await expect(region.getByRole('combobox', { name: /计划产品/ })).toHaveCount(4)
  expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  const state = await s.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)
  expect(state.analysis?.items.map(item => item.materialId).sort()).toEqual(['hospital-material-pci-balloon', 'hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter', 'hospital-material-pci-stent'])
  expect(state.analysis?.items.map(item => item.quantity)).toEqual([1, 1, 1, 1])
  const quantity = region.getByRole('spinbutton', { name: /预计数量：.*支架/ })
  await quantity.fill('2')
  await expect(region.getByText(/修改后的产品或数量超出当前核验范围/)).toBeVisible()
  await expect(region.getByRole('button', { name: '确认耗材计划', exact: true })).toBeDisabled()
  await quantity.fill('1')
  await region.getByRole('textbox', { name: /计划理由：.*支架/ }).fill('医生审阅后的合成支架用途')
  await region.getByRole('textbox', { name: '医生确认说明', exact: true }).fill('合成术前计划已核对来源与数量')
  let posts = 0
  await page.route(`**${stay.path}/drg/agent/confirm`, async route => { posts++; await route.continue() })
  const response = page.waitForResponse(response => response.url().endsWith(`${stay.path}/drg/agent/confirm`))
  await region.getByRole('button', { name: '确认耗材计划', exact: true }).click()
  const confirmedResponse = await response
  expect(confirmedResponse.status()).toBe(200)
  inpatientDrgAgentResponseSchema.parse(await confirmedResponse.json())
  await expect(region.getByRole('region', { name: '已确认耗材计划', exact: true })).toContainText('合成术前计划已核对来源与数量')
  const confirmed = await s.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)
  expect(confirmed.confirmedPlan?.revision).toBe(1)
  expect(confirmed.confirmedPlan?.items.find(item => item.materialId === 'hospital-material-pci-stent')?.reason).toBe('医生审阅后的合成支架用途')
  expect(confirmed.planHistory).toHaveLength(1)
  expect(posts).toBe(1)
  expect(app.modelFeatures).toHaveLength(2)
}

export async function runDrgAgentRecoveryJourney(page: Page, app: PciBrowserApp, open: OpenPciPatient) {
  const { s, stay, admission } = await generateDrgAgentStay(app)
  await open('inpatient-doctor', admission.patientName)
  await selectInpatientStage(page, "DRG 预分组")
  const region = page.getByRole('region', { name: '住院耗材建议', exact: true })
  await region.getByRole('textbox', { name: /计划理由：.*支架/ }).fill('医生审阅后的合成支架用途')
  await region.getByRole('textbox', { name: '医生确认说明', exact: true }).fill('合成术前计划已核对来源与数量')
  let posts = 0, originalKey: string | undefined
  await page.route(`**${stay.path}/drg/agent/confirm`, async route => {
    posts++
    originalKey = route.request().headers()['idempotency-key']
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientDrgAgentResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await region.getByRole('button', { name: '确认耗材计划', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: new RegExp(admission.patientName) }).click()
  await selectInpatientStage(page, "DRG 预分组")
  const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  const receiptQuery = new URL((await receipt).url()).searchParams
  expect(receiptQuery.get('idempotencyKey')).toBe(originalKey)
  expect(receiptQuery.get('operationId')).toBe('inpatient.drg.agent.confirm')
  await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toHaveCount(0)
  await expect(region.getByRole('region', { name: '已确认耗材计划', exact: true })).toContainText('合成术前计划已核对来源与数量')
  const confirmed = await s.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)
  expect(confirmed.confirmedPlan?.revision).toBe(1)
  expect(confirmed.confirmedPlan?.items.find(item => item.materialId === 'hospital-material-pci-stent')?.reason).toBe('医生审阅后的合成支架用途')
  expect(confirmed.planHistory).toHaveLength(1)
  expect(posts).toBe(1)
  expect(app.modelFeatures).toHaveLength(2)
}

export async function runDrgAgentInvalidationJourney(page: Page, app: PciBrowserApp, open: OpenPciPatient) {
  const { s, stay, admission, generated } = await generateDrgAgentStay(app)
  const saved = await s.request('inpatient-doctor', `${stay.path}/drg/agent/confirm`, {
    analysisId: generated.analysis!.id, expectedBasisFingerprint: generated.basisFingerprint, expectedRevision: 0,
    note: '合成已核对术前计划', items: generated.analysis!.items.map(item => ({ materialId: item.materialId,
      catalogVersion: item.catalogVersion, quantity: item.quantity, reason: '医生确认本次用途与数量' })),
  })
  expect(saved.status).toBe(200)
  const confirmed = inpatientDrgAgentResponseSchema.parse(await saved.json()).data
  await open('inpatient-doctor', admission.patientName)
  const region = page.getByRole('region', { name: '住院耗材建议', exact: true })
  await selectInpatientStage(page, "手术")
  await page.getByText('PCI 选型参数与候选依据', { exact: true }).click()
  const parameters = page.getByRole('region', { name: 'PCI 参数与候选', exact: true })
  await parameters.getByLabel('病变长度 单位', { exact: true }).fill('cm')
  await parameters.getByRole('button', { name: '确认 PCI 参数', exact: true }).click()
  await expect(parameters.getByText(/已确认参数 v2/)).toBeVisible()
  await selectInpatientStage(page, "DRG 预分组")
  await expect(region.getByText("AI分析尚未完成，依据不完整", { exact: true })).toBeVisible()
  await expect(region.getByText("历史AI建议，暂不可确认", { exact: true })).toBeVisible()
  await expect(region.getByText('原确认计划需重评，原始确认记录仍保留。', { exact: true })).toBeVisible()
  await expect(region.getByRole('button', { name: '确认耗材计划', exact: true })).toBeDisabled()
  expect((await s.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)).planHistory).toEqual(confirmed.planHistory)
  expect(app.modelFeatures).toHaveLength(2)
  const savedPlan = region.getByRole('region', { name: '已确认耗材计划', exact: true })
  await savedPlan.getByText("查看原参数与证据修订", { exact: true }).click()
  await expect(savedPlan.getByText(`原参数确认：${confirmed.confirmedPlan!.sources.selectionConfirmationId} v1`, { exact: true })).toBeVisible()
  await expect(savedPlan.getByText('原依据包：clinmesh-pci-selection-evidence · 2026-10-27.r1', { exact: true })).toBeVisible()
  await expect(savedPlan.getByText(/以下是形成该结果时固定的合成依据/)).toBeVisible()
}
