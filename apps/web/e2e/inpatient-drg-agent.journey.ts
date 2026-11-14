import { openInpatientDrgTools, selectInpatientStage } from './inpatient-ui.ts'
import { expect, type Page } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimatesSchema, inpatientMaterialEstimateResponseSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { cancelAutomaticMaterialEstimate, pciAgentParameters } from '../../server/tests/fixtures/inpatient-drg-agent.ts'
import type { PciBrowserApp } from './inpatient-pci.fixture.ts'
import type { OpenPciPatient } from './inpatient-pci-preparation.journey.ts'

export async function prepareDrgAgentStay(app: PciBrowserApp) {
  const s = app.fixture, stay = await s.preparePciAdmission([])
  await cancelAutomaticMaterialEstimate(s, stay)
  const selected = await s.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, { expectedVersion: 0, parameters: { ...pciAgentParameters, requestId: stay.requestId } })
  expect(selected.status).toBe(200)
  inpatientPciSelectionResponseSchema.parse(await selected.json())
  const initialEstimate = (await s.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!
  expect((await s.request('inpatient-doctor', `${stay.path}/material-estimates/request`, {
    requestId: stay.requestId, expectedRequestVersion: initialEstimate.requestVersion, expectedVersion: initialEstimate.version, expectedBasisFingerprint: initialEstimate.basisFingerprint,
  })).status).toBe(200)
  await expect.poll(async () => (await s.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]?.status).toBe('succeeded')
  const admission = (await s.read('inpatient-doctor', stay.path, inpatientDetailSchema)).admission
  return { s, stay, admission }
}

async function generateDrgAgentStay(app: PciBrowserApp) {
  return prepareDrgAgentStay(app)
}

export async function runDrgAgentJourney(page: Page, app: PciBrowserApp, open: OpenPciPatient) {
  const { s, stay, admission } = await prepareDrgAgentStay(app)
  await open('inpatient-doctor', admission.patientName)
  await selectInpatientStage(page, 'DRG 预分组')
  await openInpatientDrgTools(page)
  await expect(page.getByRole('region', { name: '手术耗材建议', exact: true })).toHaveCount(0)
  expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  const estimate = (await s.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!
  expect(estimate.analysis?.items.map(item => item.materialId).sort()).toEqual(['hospital-material-pci-balloon', 'hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter', 'hospital-material-pci-stent'])
  expect(estimate.analysis?.items.map(item => item.quantity)).toEqual([1, 1, 1, 1])

  await selectInpatientStage(page, '手术')
  const stepTwo = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect(stepTwo.getByRole('spinbutton', { name: /预计数量/ })).toHaveCount(4)
  let posts = 0
  await page.route(`**${stay.path}/material-estimates/confirm`, async route => { posts++; await route.continue() })
  const response = page.waitForResponse(response => response.url().endsWith(`${stay.path}/material-estimates/confirm`))
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认手术耗材', exact: true }).click()
  const confirmedResponse = await response
  expect(confirmedResponse.status()).toBe(200)
  inpatientMaterialEstimateResponseSchema.parse(await confirmedResponse.json())
  await expect(stepTwo).toContainText('已为本计划预留')
  const reserved = await s.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(reserved.reservations.filter(item => item.status === 'reserved')).toHaveLength(4)
  expect(posts).toBe(1)
  expect(app.modelFeatures).toHaveLength(2)
}

export async function runDrgAgentRecoveryJourney(page: Page, app: PciBrowserApp, open: OpenPciPatient) {
  const { s, stay, admission } = await generateDrgAgentStay(app)
  await open('inpatient-doctor', admission.patientName)
  await selectInpatientStage(page, '手术')
  const stepTwo = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect(stepTwo.getByRole('spinbutton', { name: /预计数量/ })).toHaveCount(4)
  let posts = 0, originalKey: string | undefined
  await page.route(`**${stay.path}/material-estimates/confirm`, async route => {
    posts++
    originalKey = route.request().headers()['idempotency-key']
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    inpatientMaterialEstimateResponseSchema.parse(await response.json())
    await route.abort('failed')
  })
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认手术耗材', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: new RegExp(admission.patientName) }).click()
  await selectInpatientStage(page, '手术')
  const receipt = page.waitForRequest(request => request.url().includes('/command-receipts?'))
  await page.getByRole('button', { name: '恢复原住院操作', exact: true }).click()
  const receiptQuery = new URL((await receipt).url()).searchParams
  expect(receiptQuery.get('idempotencyKey')).toBe(originalKey)
  expect(receiptQuery.get('operationId')).toBe('inpatient.material-estimate.confirm')
  await expect(page.getByRole('button', { name: '恢复原住院操作', exact: true })).toHaveCount(0)
  await expect(stepTwo).toContainText('已为本计划预留')
  const estimate = (await s.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!
  expect(estimate.draft?.confirmedRevision).toBe(1)
  expect(posts).toBe(1)
  expect(app.modelFeatures).toHaveLength(2)
}

export async function runDrgAgentInvalidationJourney(page: Page, app: PciBrowserApp, open: OpenPciPatient) {
  const { stay, admission } = await generateDrgAgentStay(app)
  await open('inpatient-doctor', admission.patientName)
  await selectInpatientStage(page, '手术')
  const stepOne = page.getByRole('region', { name: '选型参数', exact: true })
  const stepTwo = page.getByRole('region', { name: '手术耗材', exact: true })
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认手术耗材', exact: true }).click()
  await expect(stepTwo).toContainText('已为本计划预留')
  await stepOne.getByRole('button', { name: '修改', exact: true }).click()
  await stepOne.getByLabel('病变长度 (mm)', { exact: true }).fill('30')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认选型参数', exact: true }).click()
  await expect(stepTwo).toContainText('选型已变化，请核对耗材后再次确认。')
  await expect(stepTwo).toContainText('与新测量不符：')
  await expect(stepTwo.getByRole('spinbutton', { name: /预计数量：.*支架/ })).toHaveValue('1')
  expect((await app.fixture.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations.filter(item => item.status === 'reserved')).toHaveLength(4)
  expect(app.modelFeatures).toHaveLength(2)
}
