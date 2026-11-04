import type { Page } from '@playwright/test'
import { openInpatientDisclosure, selectInpatientStage } from './inpatient-ui.ts'
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
  const admission = (await f.read('inpatient-doctor', stay.path, inpatientDetailSchema)).admission
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await open()
  await openQueue(page)
  await page.getByRole('button', { name: `查看${admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  await openInpatientDisclosure(page, '耗材与指南评估')
  const actions = page.getByRole('region', { name: '当前操作', exact: true })
  const estimates = page.getByRole('region', { name: '手术耗材预计', exact: true })
  await estimates.getByRole('button', { name: '重新预计，保留耗材清单', exact: true }).click()
  await expect(estimates).toContainText('AI 预计与独立核验已完成')
  await expect(estimates.getByRole('spinbutton', { name: /预计数量/ })).toHaveCount(4)
  await estimates.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理', exact: true }).check()
  const callsBeforeConfirmation = app.modelCalls
  await actions.getByRole('button', { name: '确认整批预留', exact: true }).click()
  const source = estimates.locator('[data-material-plan-request="' + stay.requestId + '"]')
  await expect(source).toContainText('当前有效依据：单次耗材清单确认 v1')
  const confirmed = (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates[0]!.planBasis!
  expect(confirmed).toMatchObject({ status: 'confirmed', history: [{ source: 'material-estimate', sourceVersion: 1,
    items: [{ quantity: 1 }, { quantity: 1 }, { quantity: 1 }, { quantity: 1 }] }] })
  expect((await f.read('inpatient-doctor', `${stay.path}/drg/followup`, inpatientDrgFollowupSchema)).task).toBeNull()
  expect(app.modelCalls).toBe(callsBeforeConfirmation)

  await actions.getByRole('button', { name: '开始手术逐笔登记', exact: true }).click()
  const startDialog = page.getByRole('dialog', { name: '开始手术', exact: true })
  await startDialog.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${stay.procedure.coding.code} · ${stay.procedure.coding.display}`, exact: true }).click()
  await startDialog.getByLabel('开始说明', { exact: true }).fill('仅确认一次清单后按实际完成合成 PCI')
  await startDialog.getByRole('button', { name: '开始手术', exact: true }).click()
  const entries = page.getByRole('region', { name: '本台耗材', exact: true })
  await expect(entries).toContainText('手术进行中')
  await expect(estimates).toContainText('仅能在手术开始前确认；当前术前确认依据只读，工作稿编辑不会改写原确认清单。')
  await actions.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  const final = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  const name = (id: string) => stay.catalog.materials.find(item => item.id === id)!.display
  for (const id of ['hospital-material-pci-guidewire', 'hospital-material-pci-balloon', 'hospital-material-pci-stent']) {
    await final.getByLabel(new RegExp(`${name(id)} · 最终总量`)).fill('1')
  }
  await final.getByLabel('新增最终耗材', { exact: true }).click()
  await page.getByRole('option', { name: name('hospital-material-pci-guidewire'), exact: true }).click()
  await final.getByRole('checkbox', { name: new RegExp(`释放剩余预留 · ${name('hospital-material-pci-guiding-catheter')}`) }).check()
  await final.getByLabel('核实说明', { exact: true }).fill('导丝两根，导引导管未用并释放原预留，支架和球囊各一件')
  await final.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await final.getByRole('button', { name: '确认完成手术', exact: true }).click()
  await openInpatientDisclosure(page, '实际手术记录')
  await expect(page.getByText(`实际实施：${stay.procedure.coding.code} · ${stay.procedure.coding.display}`, { exact: true })).toBeVisible()
  const reservations = (await f.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)).reservations
  expect(reservations.find(item => item.materialId === 'hospital-material-pci-guiding-catheter')?.status).toBe('released')
  expect(reservations.find(item => item.materialId === 'hospital-material-pci-guidewire')?.consumedQuantity).toBe(1)

  await selectInpatientStage(page, 'DRG 预分组')
  await openInpatientDisclosure(page, '查看自动跟进')
  await page.getByRole('region', { name: '住院自动跟进', exact: true }).getByRole('button', { name: '开启本次住院跟进', exact: true }).click()
  await selectInpatientStage(page, '手术')
  const review = page.getByRole('region', { name: '术后核查与责任交接', exact: true })
  await expect(review).toContainText('当前有效依据：单次耗材清单确认 v1')
  const guidewire = review.getByRole('row').filter({ hasText: name('hospital-material-pci-guidewire') })
  await expect(guidewire.getByRole('cell').nth(1)).toHaveText('1')
  await expect(guidewire.getByRole('cell').nth(2)).toHaveText('2')
  const catheter = review.getByRole('row').filter({ hasText: name('hospital-material-pci-guiding-catheter') })
  await expect(catheter.getByRole('cell').nth(1)).toHaveText('1')
  await expect(catheter.getByRole('cell').nth(2)).toHaveText('0')
  await review.getByText('查看确认清单及来源历史', { exact: true }).click()
  await expect(review.locator('[data-material-plan-request="' + stay.requestId + '"]')).toContainText(confirmed.effectiveReference!)
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
  await expect(review).toContainText('当前有效依据：单次耗材清单确认 v1')
  expect(errors).toEqual([])
  await page.goto('about:blank')
}
