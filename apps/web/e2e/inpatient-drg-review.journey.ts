import { selectInpatientStage } from './inpatient-ui.ts'
import type { Page } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgAgentSchema, inpatientDrgAgentResponseSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientDrgFollowupSchema, inpatientDrgFollowupResponseSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { cancelAutomaticMaterialEstimate, pciAgentParameters } from '../../server/tests/fixtures/inpatient-drg-agent.ts'
import { expect, loginPciBrowser, type PciBrowserApp } from './inpatient-pci.fixture.ts'

export async function prepareDrgReviewBrowser(app: PciBrowserApp) {
  const f = app.fixture, stay = await f.preparePciAdmission()
  await cancelAutomaticMaterialEstimate(f, stay)
  const selected = await f.request('inpatient-doctor', `${stay.path}/pci-selection/confirm`, { expectedVersion: 0,
    parameters: { ...pciAgentParameters, requestId: stay.requestId } })
  expect(selected.status).toBe(200); inpatientPciSelectionResponseSchema.parse(await selected.json())
  const started = await f.request('inpatient-doctor', `${stay.path}/drg/followup/start`, { encounterVersion: stay.encounterVersion, expectedTaskVersion: 0 })
  expect(started.status).toBe(200); inpatientDrgFollowupResponseSchema.parse(await started.json())
  await expect.poll(async () => (await f.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)).status).toBe('succeeded')
  const pre = await f.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)
  const plan = await f.request('inpatient-doctor', `${stay.path}/drg/agent/confirm`, { analysisId: pre.analysis!.id,
    expectedBasisFingerprint: pre.basisFingerprint, expectedRevision: 0, note: '合成浏览器人工术前计划确认',
    items: pre.analysis!.items.map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: item.quantity, reason: '医生确认本次用途与预计数量' })) })
  expect(plan.status).toBe(200); inpatientDrgAgentResponseSchema.parse(await plan.json())
  const executionInput = await f.pciExecutionInput(stay)
  const result = await f.request('inpatient-doctor', `${stay.path}/surgeries/execute`, { ...executionInput,
    materials: executionInput.materials.map(item => item.materialId === 'hospital-material-pci-guidewire'
      ? { materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: 2 } : item) })
  expect(result.status).toBe(200)
  const execution = inpatientSurgeryResponseSchema.parse(await result.json()).data.executions[0]!
  await f.confirmMainProcedure(stay, execution.id)
  await expect.poll(async () => (await f.read('inpatient-doctor', `${stay.path}/drg/review`, inpatientDrgReviewSchema)).model?.current).toBe(true)
  const admission = (await f.read('inpatient-doctor', stay.path, inpatientDetailSchema)).admission
  return { stay, execution, admission }
}

export async function runDrgReviewJourney(page: Page, app: PciBrowserApp, prepared: Awaited<ReturnType<typeof prepareDrgReviewBrowser>>, open: () => Promise<void>) {
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await open()
  await page.getByRole('button', { name: `查看${prepared.admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, "DRG 预分组")
  const panel = page.getByRole('region', { name: '术后核查与责任交接', exact: true })
  await expect(panel).toContainText('阶段 DRG FM39')
  await expect(panel).toContainText("术后AI解释已完成独立核验")
  const todo = panel.locator('article').filter({ hasText: '实际使用数量超过术前人工计划' })
  await expect(todo).toHaveCount(1)
  await expect(todo).toContainText('负责岗位：住院医生')
  await todo.getByLabel('待办处理说明', { exact: true }).fill('术者正在核实额外一根导丝用途')
  await todo.getByRole('button', { name: '标记处理中', exact: true }).click()
  await expect(todo.getByText('处理中', { exact: true })).toBeVisible()
  await page.getByLabel('停止跟进理由', { exact: true }).fill('合成停止本轮分析并保留未解决责任')
  await page.getByRole('button', { name: '停止本次跟进', exact: true }).click()
  await panel.getByLabel('本轮交接说明', { exact: true }).fill('额外导丝用途仍未解决，由当前住院医生继续负责')
  await panel.getByRole('button', { name: '确认交接并保留未解决责任', exact: true }).click()
  await expect(panel).toContainText('本轮已交接')
  await expect(todo.getByText('处理中', { exact: true })).toBeVisible()
  const state = await app.fixture.read('inpatient-doctor', `${prepared.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(state.todos.find(item => item.kind === 'extra-use')).toMatchObject({ status: 'in-progress', ownerRole: 'inpatient-doctor' })
  expect(state.handedOver).not.toBeNull()
  await page.goto('about:blank')
}

export async function runMedicalRecordsReviewJourney(page: Page, app: PciBrowserApp, open: () => Promise<void>) {
  const prepared = await prepareDrgReviewBrowser(app), f = app.fixture
  delete f.options.drgRulesDirectory
  await f.restart()
  await f.runtime.dispatchPending()
  const before = await f.read('medical-records', `${prepared.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(before.todos.some(todo => todo.kind === 'grouping-incomplete' && todo.ownerRole === 'medical-records')).toBe(true)
  const requestsBefore = app.modelCalls
  await loginPciBrowser(page, app, 'medical-records')
  await open()
  await page.getByRole('button', { name: `查看${prepared.admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, "病案")
  await expect(page.getByRole('tab', { name: "DRG 预分组", exact: true })).toHaveCount(0)
  const panel = page.getByRole('region', { name: '术后核查与责任交接', exact: true })
  const todo = panel.locator('article').filter({ hasText: '阶段性分组依据不完整' })
  await expect(todo).toContainText('负责岗位：病案人员')
  await todo.getByLabel('待办处理说明', { exact: true }).fill('病案人员正在核对分组规则及来源')
  await todo.getByRole('button', { name: '标记处理中', exact: true }).click()
  await expect(todo.getByText('处理中', { exact: true })).toBeVisible()
  const followup = await f.read('inpatient-doctor', `${prepared.stay.path}/drg/followup`, inpatientDrgFollowupSchema)
  const stopped = await f.request('inpatient-doctor', `${prepared.stay.path}/drg/followup/stop`, {
    encounterVersion: followup.encounterVersion, expectedTaskVersion: followup.task!.version, reason: '本轮停止并由病案岗位交接未解决问题',
  })
  expect(stopped.status).toBe(200)
  inpatientDrgFollowupResponseSchema.parse(await stopped.json())
  await panel.getByLabel('本轮交接说明', { exact: true }).fill('分组依据待核实，继续由病案岗位负责')
  await panel.getByRole('button', { name: '确认交接并保留未解决责任', exact: true }).click()
  await expect(panel).toContainText('本轮已交接')
  const after = await f.read('medical-records', `${prepared.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(after.todos.find(item => item.kind === 'grouping-incomplete')).toMatchObject({ status: 'in-progress', ownerRole: 'medical-records' })
  expect(after.handedOver?.role).toBe('medical-records')
  expect(app.modelCalls).toBe(requestsBefore)
  await page.goto('about:blank')
}
