import type { Page } from '@playwright/test'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientGuidelineAdviceListSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { modelUsageListSchema, modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { expect, openPciAiPatient, pciAiQuotes, preparePciAiPatient, type PciAiBrowserApp } from './inpatient-pci-ai.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

export async function runPciAiJourney(page: Page, app: PciAiBrowserApp) {
  const stay = await preparePciAiPatient(app), f = app.fixture
  const errors: string[] = [], writes: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
  const open = async (role = 'inpatient-doctor') => openPciAiPatient(page, app, role, stay.patientName)
  const stage = (name: string) => selectInpatientStage(page, name)
  const catalog = await f.read('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema)
  const angiography = catalog.procedures.find(item => item.coding.code === '88.5500')!
  const pci = catalog.procedures.find(item => item.coding.code === '36.0700')!
  const requestSurgery = async (code: string, reason: string) => {
    await page.getByLabel('计划术式', { exact: true }).click()
    await page.getByRole('option', { name: new RegExp(code) }).click()
    await page.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-08-24T15:00')
    await page.getByLabel('手术申请理由', { exact: true }).fill(reason)
    await page.getByRole('button', { name: '申请手术', exact: true }).click()
    await expect(page.getByRole('region', { name: '住院手术', exact: true })).toContainText(reason)
    return (await f.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)).requests.find(item => item.reason === reason)!
  }
  const prepareSurgery = async (reason: string) => {
    await open('ward-nurse'); await stage('手术')
    let plan = page.getByRole('region', { name: '住院手术', exact: true }).locator('article').filter({ hasText: reason })
    await plan.getByLabel('手术记录说明', { exact: true }).fill('已核对合成术前准备')
    await plan.getByRole('button', { name: '术前核对', exact: true }).click()
    await expect(plan).toContainText('术前核对：已核对')
    await open(); await stage('手术')
    plan = page.getByRole('region', { name: '住院手术', exact: true }).locator('article').filter({ hasText: reason })
    await plan.getByLabel('手术记录说明', { exact: true }).fill('已确认合成知情同意')
    await plan.getByRole('button', { name: '确认手术知情同意书已签', exact: true }).click()
    await expect(plan).toContainText('已就绪')
    return plan
  }
  expect(app.calls).toEqual([])
  await open(); await stage('手术')
  const angiographyRequest = await requestSurgery('88.5500', '合成AI验收诊断造影')
  await expect.poll(async () => (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === angiographyRequest.id)?.status).toBe('succeeded')
  expect(app.calls).toEqual([{ kind: 'material', phase: 'angiography', feature: 'inpatient_drg_recommendation' }, { kind: 'material', phase: 'angiography', feature: 'inpatient_drg_verification' }])
  const angioPlan = await prepareSurgery(angiographyRequest.reason)
  await angioPlan.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${angiography.coding.code} · ${angiography.coding.display}`, exact: true }).click()
  const beforeReport = [...app.calls]
  await angioPlan.getByRole('button', { name: '记录实际手术', exact: true }).click()
  const reports = () => f.read('inpatient-doctor', `${stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)
  await expect.poll(async () => (await reports()).reports[0]?.status).toBe('final')
  const report = (await reports()).reports[0]!
  expect(report.measurements.map(item => item.value)).toEqual([12, 3, 3])
  expect(app.calls).toEqual(beforeReport)
  await stage('病案')
  await page.getByLabel('确认本次主操作', { exact: true }).click()
  await page.getByRole('option', { name: `${angiography.coding.code} · ${angiography.coding.display}`, exact: true }).click()
  await page.getByRole('button', { name: '提交首页修订', exact: true }).click()
  await stage('手术')
  const planned = await requestSurgery('36.0700', '合成AI验收PCI计划')
  const selection = () => f.read('inpatient-doctor', `${stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect((await selection()).confirmation).toBeNull()
  const panel = page.getByRole('region', { name: '手术耗材预计', exact: true }).getByRole('article', { name: `耗材预计：${pci.coding.display}`, exact: true })
  const parameters = panel.getByRole('region', { name: '报告带入的 PCI 参数', exact: true })
  await expect(parameters.getByLabel('病变长度 数值', { exact: true })).toHaveValue('12')
  await expect(parameters.getByLabel('近端参考直径 数值', { exact: true })).toHaveValue('3')
  await expect(parameters.getByLabel('远端参考直径 数值', { exact: true })).toHaveValue('3')
  await parameters.getByText('依据', { exact: true }).click()
  await expect(parameters).toContainText(`DiagnosticReport/${report.id}`)
  await expect(parameters).toContainText('定量冠脉造影（合成）')
  await expect(panel).toContainText('AI 预计与独立核验已完成')
  const costs = panel.getByRole('region', { name: '住院费用与医保参考', exact: true })
  await expect(costs.getByRole('region', { name: '当前正式分组', exact: true })).toContainText('FM59')
  await expect(costs.getByRole('region', { name: '计划实施推演分组', exact: true })).toContainText('FM39')
  const guidelines = page.getByRole('region', { name: '指南参考意见', exact: true })
  for (const [index, kind] of ['支架类别', 'IVUS／OCT 指导条件', '尺寸与测量要求'].entries()) {
    await guidelines.getByText(`查看${kind}依据`, { exact: true }).click()
    for (const quote of pciAiQuotes[index]!) await expect(guidelines.getByRole('group', { name: `${kind}依据`, exact: true })).toContainText(quote)
  }
  expect(app.calls.filter(call => call.kind === 'guideline')).toHaveLength(2)
  expect(app.calls.filter(call => call.kind === 'material' && call.phase === 'pci')).toHaveLength(2)
  expect(app.calls).toHaveLength(6)
  const estimateStates = (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates
  const guideline = (await f.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  for (const [taskId, stages] of [
    [estimateStates.find(item => item.requestId === angiographyRequest.id)!.id, ['estimate-1-generation', 'estimate-1-verification']],
    [estimateStates.find(item => item.requestId === planned.id)!.id, ['estimate-1-generation', 'estimate-1-verification']],
    [guideline.taskId!, ['guideline-1-generation', 'guideline-1-verification']],
  ] as const) {
    const attempts = await f.read('inpatient-doctor', `/api/model-usage/requests?caseId=${stay.admissionId}&taskId=${taskId}`, modelUsageListSchema)
    expect(attempts.items.map(item => item.context.stage).sort()).toEqual(stages)
    expect(attempts.items.every(item => item.context.caseId === stay.admissionId && item.context.taskId === taskId)).toBe(true)
  }
  const usage = await f.read('inpatient-doctor', `/api/model-usage/overview?caseId=${stay.admissionId}`, modelUsageOverviewSchema)
  expect(usage.totals).toMatchObject({ requests: 6, knownInputTokens: 600, knownOutputTokens: 120 })
  await panel.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理', exact: true }).check()
  await page.getByRole('button', { name: '确认选型、清单与预留', exact: true }).click()
  await expect.poll(async () => (await selection()).confirmation?.parameters.requestId).toBe(planned.id)
  const reservations = await f.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(reservations.reservations.filter(item => item.requestId === planned.id && item.status === 'reserved')).toHaveLength(4)
  expect(writes.filter(path => path.endsWith('/material-estimates/confirm'))).toHaveLength(1)
  expect(writes.filter(path => path.endsWith('/pci-selection/confirm'))).toHaveLength(0)
  expect((await f.read('inpatient-doctor', `${stay.path}/drg/followup`, inpatientDrgFollowupSchema)).task).toBeNull()
  const pciPlan = await prepareSurgery(planned.reason)
  await pciPlan.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${pci.coding.code} · ${pci.coding.display}`, exact: true }).click()
  await page.getByRole('button', { name: '开始手术逐笔登记', exact: true }).click()
  const live = page.getByRole('region', { name: '本台耗材与实时费用', exact: true }).filter({ has: page.getByRole('row', { name: /导丝/ }) })
  const wire = catalog.materials.find(item => item.id === 'hospital-material-pci-guidewire')!
  const entry = page.getByRole('region', { name: '术中耗材逐笔登记', exact: true }).filter({ hasText: '手术进行中' })
  await entry.getByLabel('本笔耗材产品', { exact: true }).click()
  await page.getByRole('option', { name: wire.display, exact: true }).click()
  await entry.getByLabel('本笔实际数量', { exact: true }).fill('2')
  await entry.getByLabel('本笔使用或更正依据', { exact: true }).fill('核对额外导丝实际用途')
  const beforeUse = [...app.calls]
  await entry.getByRole('button', { name: '确认登记本笔使用', exact: true }).click()
  await expect(live.getByRole('row', { name: /导丝/ })).toContainText('超出计划 1')
  await f.runtime.dispatchPending()
  expect(app.calls).toEqual(beforeUse)
  await page.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  await page.getByLabel('最终用量核实依据', { exact: true }).fill('合成PCI最终用量核对，仅导丝使用两根')
  await page.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await page.getByRole('button', { name: '确认完成本次手术', exact: true }).click()
  await stage('DRG 预分组')
  const review = page.getByRole('region', { name: '术后核查与责任交接', exact: true })
  await expect(review).toContainText(wire.display)
  await expect(review).toContainText('计划量：1')
  await expect(review).toContainText('实际量：2')
  await review.getByRole('button', { name: '前往手术原记录', exact: true }).first().click()
  await expect(page.getByRole('tab', { name: '手术', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect((await f.read('inpatient-doctor', `${stay.path}/drg/review`, inpatientDrgReviewSchema)).todos.some(item => item.kind === 'extra-use')).toBe(true)
  expect(app.calls).toEqual(beforeUse)
  expect(errors).toEqual([])
}
