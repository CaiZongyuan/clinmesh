import type { Page } from '@playwright/test'
import { selectInpatientStage } from './inpatient-ui.ts'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { cancelAutomaticMaterialEstimate, pciAgentParameters } from '../../server/tests/fixtures/inpatient-drg-agent.ts'
import { expect, loginPciBrowser, type PciBrowserApp } from './inpatient-pci.fixture.ts'
import { openQueue } from './queue-overlay.fixture.ts'

/** 同一次清单确认的生产表单和公开 HTTP 证据由 Web 与 React 18/19 Surface 共用。 */
export async function runMaterialPlanReviewJourney(page: Page, app: PciBrowserApp, open: () => Promise<void>) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const f = app.fixture, stay = await f.preparePciAdmission([])
  await cancelAutomaticMaterialEstimate(f, stay)
  const selected = await f.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, { expectedVersion: 0,
    parameters: { ...pciAgentParameters, requestId: stay.requestId } })
  expect(selected.status).toBe(200)
  inpatientPciSelectionResponseSchema.parse(await selected.json())
  await f.pciExecutionInput(stay)
  const initialEstimate = (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!
  expect((await f.request('inpatient-doctor', `${stay.path}/material-estimates/request`, {
    requestId: stay.requestId, expectedRequestVersion: initialEstimate.requestVersion, expectedVersion: initialEstimate.version, expectedBasisFingerprint: initialEstimate.basisFingerprint,
  })).status).toBe(200)
  await expect.poll(async () => (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]?.status).toBe('succeeded')
  const admission = (await f.read('inpatient-doctor', stay.path, inpatientDetailSchema)).admission
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  const actions = page.getByRole('region', { name: '当前操作', exact: true })
  const estimates = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect(estimates.getByRole('spinbutton', { name: /预计数量/ })).toHaveCount(4)
  const callsBeforeConfirmation = app.modelCalls
  await actions.getByRole('button', { name: '确认手术耗材', exact: true }).click()
  await expect(estimates).toContainText('已为本计划预留')
  const confirmed = (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!.planBasis!
  expect(confirmed).toMatchObject({ status: 'confirmed', history: [{ source: 'material-estimate', sourceVersion: 1,
    items: [{ quantity: 1 }, { quantity: 1 }, { quantity: 1 }, { quantity: 1 }] }] })
  expect((await f.read('inpatient-doctor', `${stay.path}/drg/followup`, inpatientDrgFollowupSchema)).task).toBeNull()
  expect(app.modelCalls).toBe(callsBeforeConfirmation)

  await actions.getByRole('button', { name: '开始手术', exact: true }).click()
  const startDialog = page.getByRole('dialog', { name: '开始手术', exact: true })
  await startDialog.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${stay.procedure.coding.code} · ${stay.procedure.coding.display}`, exact: true }).click()
  await startDialog.getByLabel('开始说明', { exact: true }).fill('仅确认一次清单后按实际完成合成 PCI')
  await startDialog.getByRole('button', { name: '开始手术', exact: true }).click()
  const entries = page.getByRole('region', { name: '本台耗材', exact: true })
  await expect(entries).toContainText('手术进行中')
  await expect(estimates).toHaveCount(0)
  await actions.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  const final = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  await final.getByRole('button', { name: '有出入，改数量', exact: true }).click()
  const name = (id: string) => stay.catalog.materials.find(item => item.id === id)!.display
  for (const id of ['hospital-material-pci-guidewire', 'hospital-material-pci-balloon', 'hospital-material-pci-stent']) {
    await final.getByLabel(new RegExp(`${name(id)} · 最终总量`)).fill('1')
  }
  await final.getByRole('button', { name: '新增最终耗材', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '选择最终耗材', exact: true })
  await picker.getByLabel('搜索耗材', { exact: true }).fill(name('hospital-material-pci-guidewire'))
  await picker.getByRole('button', { name: `加入${name('hospital-material-pci-guidewire')}`, exact: true }).click()
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: '完成选择', exact: true }).click()
  await final.getByRole('checkbox', { name: new RegExp(`释放剩余预留 · ${name('hospital-material-pci-guiding-catheter')}`) }).check()
  await final.getByLabel('核实说明', { exact: true }).fill('导丝两根，导引导管未用并释放原预留，支架和球囊各一件')
  await expect(page.getByRole('button', { name: '确认完成手术', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '确认完成手术', exact: true }).click()
  const done = page.getByRole('region', { name: '最终耗材', exact: true })
  await expect(done).toContainText(stay.procedure.coding.code)
  await expect(done).toContainText(stay.procedure.coding.display)
  const reservations = (await f.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations
  expect(reservations.find(item => item.materialId === 'hospital-material-pci-guiding-catheter')?.status).toBe('released')
  expect(reservations.find(item => item.materialId === 'hospital-material-pci-guidewire')?.consumedQuantity).toBe(1)

  const toggle = page.getByRole('region', { name: '当前住院患者', exact: true }).getByRole('button', { name: '助手自动跟进', exact: true })
  await toggle.click()
  await page.getByRole('dialog', { name: '开启助手自动跟进', exact: true }).getByRole('button', { name: '开启', exact: true }).click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const review = page.getByRole('region', { name: '术后核查与责任交接', exact: true })
  await expect(review).toBeVisible()
  await expect(review).toContainText('负责岗位：住院医生')
  const state = await f.read('inpatient-doctor', `${stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(state.planBases).toContainEqual(confirmed)
  expect(state.todos.some(todo => todo.kind === 'extra-use')).toBe(true)
  expect(state.todos.some(todo => todo.kind === 'unused-plan')).toBe(true)
  expect(state.todos.some(todo => todo.kind === 'missing-plan')).toBe(false)
  expect(writes.filter(path => path.endsWith('/material-estimates/confirm'))).toHaveLength(1)
  expect(writes.filter(path => path.endsWith('/drg/agent/confirm'))).toHaveLength(0)
  await page.reload()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  await expect(done).toContainText(stay.procedure.coding.display)
  expect(errors).toEqual([])
  await page.goto('about:blank')
}
