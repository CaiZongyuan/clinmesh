import type { Locator, Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimatesSchema, inpatientMaterialEstimateResponseSchema, type InpatientMaterialEstimate } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientGuidelineAdviceListSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { modelUsageListSchema, modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { expect, openPciAiPatient, pciAiQuotes, preparePciAiPatient, test, type PciAiBrowserApp } from './inpatient-pci-ai.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

export async function requestPciAiSurgery(page: Page, app: PciAiBrowserApp, path: string, code: string, reason: string) {
  await page.getByLabel('计划术式', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(code) }).click()
  await page.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-08-24T15:00')
  await page.getByLabel('手术申请理由', { exact: true }).fill(reason)
  await page.getByRole('button', { name: '申请手术', exact: true }).click()
  await expect(page.getByRole('region', { name: '住院手术', exact: true })).toContainText(reason)
  return (await app.fixture.read('inpatient-doctor', `${path}/surgeries`, inpatientSurgerySchema)).requests.find(item => item.reason === reason)!
}

export async function preparePciAiPlan(page: Page, app: PciAiBrowserApp) {
  const stay = await preparePciAiPatient(app), f = app.fixture
  const errors: string[] = [], writes: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
  const open = async (role = 'inpatient-doctor') => openPciAiPatient(page, app, role, stay.patientName)
  const stage = (name: string) => selectInpatientStage(page, name)
  const catalog = await f.read('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema)
  const angiography = catalog.procedures.find(item => item.coding.code === '88.5500')!
  const pci = catalog.procedures.find(item => item.coding.code === '36.0700')!
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
  const angiographyRequest = await requestPciAiSurgery(page, app, stay.path, '88.5500', '合成AI验收诊断造影')
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
  const planned = await requestPciAiSurgery(page, app, stay.path, '36.0700', '合成AI验收PCI计划')
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
  await expect(costs.getByRole('region', { name: '如按计划手术', exact: true })).toContainText('FM39')
  return { stay, planned, panel, selection, errors, writes, prepareSurgery, catalog, angiographyRequest }
}

export async function preparePciAiReview(page: Page, app: PciAiBrowserApp) {
  const prepared = await preparePciAiPlan(page, app)
  const { stay, planned, angiographyRequest } = prepared, f = app.fixture
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
  return prepared
}

export async function runPciAiJourney(page: Page, app: PciAiBrowserApp) {
  const { stay, planned, panel, selection, errors, writes, prepareSurgery, catalog } = await preparePciAiReview(page, app)
  const f = app.fixture, pci = planned.plannedProcedure, stage = (name: string) => selectInpatientStage(page, name)
  const estimate = (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === planned.id)!
  const costExplanation = estimate.analysis?.costExplanation ?? ''
  expect(costExplanation.trim()).not.toBe('')
  await expect(panel.getByRole('region', { name: '当前AI费用说明', exact: true })).toContainText(costExplanation)
  await expect(panel.getByRole('region', { name: '住院费用与医保参考', exact: true })).toBeVisible()
  await panel.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理', exact: true }).check()
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
  const wireTodo = review.getByRole('article').filter({ has: page.getByRole('heading', { name: wire.display, exact: true }) })
  await expect(wireTodo).toHaveCount(1)
  await expect(wireTodo).toContainText('计划量：1')
  await expect(wireTodo).toContainText('实际量：2')
  await wireTodo.getByRole('button', { name: '前往手术原记录', exact: true }).click()
  await expect(page.getByRole('tab', { name: '手术', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect((await f.read('inpatient-doctor', `${stay.path}/drg/review`, inpatientDrgReviewSchema)).todos.some(item => item.kind === 'extra-use')).toBe(true)
  expect(app.calls).toEqual(beforeUse)
  expect(errors).toEqual([])
}

export async function runPciAiMissingUnitJourney(page: Page, app: PciAiBrowserApp) {
  const { stay, planned, panel, selection } = await preparePciAiReview(page, app)
  const parameters = panel.getByRole('region', { name: '报告带入的 PCI 参数', exact: true })
  const guide = page.getByRole('region', { name: '指南参考意见', exact: true })
  const read = async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  await parameters.getByLabel('病变长度 单位', { exact: true }).fill('')
  await panel.getByRole('button', { name: '保存选型参数', exact: true }).click()
  await expect.poll(async () => (await read()).status).toBe('stale')
  await expect(guide).toContainText('患者资料、计划、目录或指南依据已变化')
  await expect(guide.getByText('查看支架类别依据', { exact: true })).toHaveCount(0)
  expect(app.calls.filter(call => call.kind === 'guideline')).toHaveLength(2)
  await guide.getByRole('button', { name: '按当前依据重新评估指南', exact: true }).click()
  await expect.poll(async () => (await read()).status).toBe('incomplete')
  await expect(guide).toContainText('病变长度缺少单位。')
  await expect(guide.getByText('有条件的参考', { exact: true })).toHaveCount(3)
  await guide.getByText('查看尺寸与测量要求依据', { exact: true }).click()
  for (const quote of pciAiQuotes[2]) await expect(guide.getByRole('group', { name: '尺寸与测量要求依据', exact: true })).toContainText(quote)
  await expect(parameters.getByLabel('病变长度 单位', { exact: true })).toHaveValue('')
  const draft = (await selection()).drafts!.find(item => item.requestId === planned.id)!
  expect(draft.parameters.measurements.find(item => item.kind === 'lesion-length')?.unit).toBeNull()
  const report = (await app.fixture.read('inpatient-doctor', `${stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).reports.find(item => item.id === draft.reportId)!
  expect(report.measurements.find(item => item.kind === 'lesion-length')?.unit).toBe('mm')
  expect(app.calls.filter(call => call.kind === 'guideline')).toHaveLength(4)
  expect(app.calls.filter(call => call.kind === 'material')).toHaveLength(4)
}

export async function runPciAiFrozenJourney(page: Page, app: PciAiBrowserApp) {
  const { stay, planned, panel, prepareSurgery } = await preparePciAiReview(page, app)
  const read = async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  const original = await read(), calls = [...app.calls]
  const plan = await prepareSurgery(planned.reason)
  await plan.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${planned.plannedProcedure.coding.code} · ${planned.plannedProcedure.coding.display}`, exact: true }).click()
  await page.getByRole('button', { name: '开始手术逐笔登记', exact: true }).click()
  await expect.poll(async () => (await read()).status).toBe('frozen')
  const posts: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith(stay.path)) posts.push(request.url()) })
  const guide = page.getByRole('region', { name: '指南参考意见', exact: true })
  await expect(guide).toContainText('指南参考意见保留历史只读')
  await expect(guide.getByRole('button', { name: '按当前依据重新评估指南', exact: true })).toHaveCount(0)
  await guide.getByText('查看支架类别依据', { exact: true }).click()
  await expect(guide.getByRole('group', { name: '支架类别依据', exact: true })).toContainText(pciAiQuotes[0][0])
  await expect(panel).toContainText('当前术前确认依据只读，工作稿编辑不会改写原确认清单。')
  await expect(panel.getByRole('region', { name: '报告带入的 PCI 参数', exact: true }).getByLabel('病变长度 数值', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '确认选型、清单与预留', exact: true })).toBeDisabled()
  await guide.getByRole('button', { name: '刷新指南状态', exact: true }).click()
  expect((await read()).result).toEqual(original.result)
  expect(posts).toEqual([])
  expect(app.calls).toEqual(calls)
}

export async function runPciAiMenuFocusJourney(page: Page, app: PciAiBrowserApp) {
  const { stay, panel } = await preparePciAiReview(page, app)
  await panel.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理', exact: true }).check()
  const confirm = page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认选型、清单与预留', exact: true })
  await expect(confirm).toBeFocused()
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu')
  const ownsFocus = () => menu.evaluate(element => {
    const root = element.getRootNode()
    return element.contains(root instanceof ShadowRoot ? root.activeElement : element.ownerDocument.activeElement)
  })
  await expect.poll(ownsFocus).toBe(true)
  let release!: () => void, holding = false
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**${stay.path}/material-estimates`, async route => { holding = true; await held; await route.continue() })
  try {
    await expect.poll(() => holding).toBe(true)
    await expect(confirm).toBeDisabled()
    await expect.poll(ownsFocus).toBe(true)
    release()
    await expect(confirm).toBeEnabled()
    await expect.poll(ownsFocus).toBe(true)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(confirm).toBeEnabled()
    await expect(panel.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理', exact: true })).toBeChecked()
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
}

export async function capturePciAiReviewLayouts(page: Page, panel: Locator) {
  const workspace = page.locator('.clinmesh-card-workspace'), root = page.locator('.clinmesh-web-root')
  const surface = await root.evaluate(element => element.getRootNode() instanceof ShadowRoot)
  const originalViewport = page.viewportSize(), originalWidth = await workspace.evaluate(element => element.style.width)
  const evidence: Array<{ width: number; theme: string; issues: string[]; regions: Array<{ name: string; width: number; clientWidth: number; scrollWidth: number }>; action: { x: number; y: number; width: number; height: number } | null }> = []
  await page.setViewportSize({ width: 1400, height: 900 })
  try {
    for (const width of [1101, 826, 760]) for (const theme of ['light', 'dark'] as const) await test.step(`PCI审阅容器 ${width}px ${theme}`, async () => {
      await workspace.evaluate((element, width) => { element.style.width = `${width}px` }, width)
      await expect.poll(() => workspace.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(width)
      if (surface) await root.evaluate((element, theme) => { element.classList.toggle('dark', theme === 'dark'); element.dataset.theme = theme }, theme)
      else {
        await page.getByRole('button', { name: '用户菜单', exact: true }).click()
        await page.getByRole('menuitemradio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('menu')).toHaveCount(0)
      }
      await expect.poll(() => root.evaluate(element => element.classList.contains('dark'))).toBe(theme === 'dark')
      await panel.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理', exact: true }).check()
      const issues: string[] = [], regions: Array<{ name: string; width: number; clientWidth: number; scrollWidth: number }> = []
      for (const [name, region] of [
        ['parameters', panel.getByRole('region', { name: '报告带入的 PCI 参数', exact: true })],
        ['costs', panel.getByRole('region', { name: '住院费用与医保参考', exact: true })],
        ['guidelines', page.getByRole('region', { name: '指南参考意见', exact: true })],
      ] as const) {
        await region.scrollIntoViewIfNeeded()
        const bounds = await region.evaluate(element => {
          const rect = element.getBoundingClientRect(), main = element.closest('.clinmesh-card-main')!.getBoundingClientRect()
          return { width: rect.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, left: rect.left, right: rect.right, mainLeft: main.left, mainRight: main.right }
        })
        regions.push({ name, width: bounds.width, clientWidth: bounds.clientWidth, scrollWidth: bounds.scrollWidth })
        if (bounds.width <= 0 || bounds.scrollWidth > bounds.clientWidth + 1 || bounds.left < bounds.mainLeft - 1 || bounds.right > bounds.mainRight + 1) issues.push(`${name}: ${JSON.stringify(bounds)}`)
      }
      const measurement = panel.getByRole('region', { name: '报告带入的 PCI 参数', exact: true }).getByLabel('病变长度 数值', { exact: true })
      expect((await measurement.boundingBox())?.width).toBeGreaterThan(40)
      const action = page.getByRole('region', { name: '当前操作', exact: true })
      await expect(action.getByRole('button', { name: '确认选型、清单与预留', exact: true })).toBeEnabled()
      const bar = await action.boundingBox(), main = await workspace.locator('.clinmesh-card-main').boundingBox()
      if (!bar || !main || bar.x < main.x - 1 || bar.x + bar.width > main.x + main.width + 1 || bar.y < 0 || bar.y + bar.height > 901) issues.push(`action: ${JSON.stringify({ bar, main })}`)
      issues.push(...await action.evaluate(element => {
        const issues: string[] = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent?.replace(/\s/g, '') ?? ''
          if ([...text].length < 6) continue
          const range = document.createRange(), lines = new Set<number>()
          range.selectNodeContents(node)
          for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) lines.add(Math.round(rect.top))
          if (lines.size > 1 && [...text].length / lines.size < 2) issues.push(`action single-character wrapping: ${text} (${lines.size} lines)`)
        }
        return issues
      }))
      if (!await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)) issues.push('document horizontal overflow')
      const layout = { width, theme, issues, regions, action: bar }
      evidence.push(layout)
      const path = test.info().outputPath(`pci-review-${width}-${theme}.png`)
      const geometryPath = test.info().outputPath(`pci-review-${width}-${theme}-geometry.json`)
      await page.screenshot({ path, animations: 'disabled' })
      await writeFile(geometryPath, `${JSON.stringify(layout, null, 2)}\n`)
      await test.info().attach(`pci-review-${width}-${theme}`, { path, contentType: 'image/png' })
      await test.info().attach(`pci-review-${width}-${theme}-geometry`, { path: geometryPath, contentType: 'application/json' })
      expect(issues).toEqual([])
      if ((width === 826 && theme === 'light') || (width === 760 && theme === 'dark')) {
        for (const [name, target, block] of [
          ['parameters-top', panel.getByRole('region', { name: '报告带入的 PCI 参数', exact: true }), 'start'],
          ['costs-top', panel.getByRole('region', { name: '住院费用与医保参考', exact: true }), 'start'],
          ['fees-current-ai', panel.getByRole('region', { name: '当前AI费用说明', exact: true }), 'end'],
        ] as const) {
          await target.evaluate((element, block) => element.scrollIntoView({ block, inline: 'nearest' }), block)
          const detailPath = test.info().outputPath(`pci-review-${width}-${theme}-${name}.png`)
          await page.screenshot({ path: detailPath, animations: 'disabled' })
          await test.info().attach(`pci-review-${width}-${theme}-${name}`, { path: detailPath, contentType: 'image/png' })
        }
      }
    })
  } finally {
    await workspace.evaluate((element, width) => { element.style.width = width }, originalWidth)
    if (originalViewport) await page.setViewportSize(originalViewport)
  }
  return evidence
}

export async function runPciAiSaveConcurrencyJourney(page: Page, app: PciAiBrowserApp) {
  const { stay, planned, panel, selection, errors } = await preparePciAiReview(page, app)
  const f = app.fixture, note = panel.getByRole('textbox', { name: '耗材清单说明', exact: true })
  const read = async () => (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === planned.id)!
  const initial = await read()
  expect(initial.draft?.revision).toBe(1)
  expect(initial.draft?.analysisId).toBe(initial.analysis?.id)
  const completed = page.getByText(`已完成本次操作 · ${stay.patientName}`, { exact: true })
  await expect(completed).toHaveCount(0)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const requests: Array<{ expectedDraftRevision: number; expectedBasisFingerprint: string; analysisId: string | null; note: string }> = []
  const saved: InpatientMaterialEstimate[] = []
  await page.route(`**${stay.path}/material-estimates/save`, async route => {
    requests.push(route.request().postDataJSON().input)
    if (requests.length === 1) await gate
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    saved.push(inpatientMaterialEstimateResponseSchema.parse(await response.json()).data)
    await route.fulfill({ response })
  })
  try {
    await note.fill('第一版正在保存的清单说明')
    await expect.poll(() => requests.length).toBe(1)
    await expect(note).toBeEditable()
    expect(await note.evaluate(element => element.closest('[inert]') === null)).toBe(true)
    await note.fill('保存期间继续输入的最新说明')
    await expect(note).toHaveValue('保存期间继续输入的最新说明')
    await expect(completed).toHaveCount(0)
    release()
    await expect.poll(async () => (await read()).draft?.note).toBe('保存期间继续输入的最新说明')
    await expect.poll(() => saved.length).toBe(2)
    expect(requests.map(request => request.expectedDraftRevision)).toEqual([1, 2])
    expect(saved.map(state => state.draft?.revision)).toEqual([2, 3])
    expect(requests[1]).toMatchObject({ expectedBasisFingerprint: saved[0]!.basisFingerprint, analysisId: saved[0]!.draft!.analysisId, note: '保存期间继续输入的最新说明' })
    const latest = await read()
    expect(latest.draft).toMatchObject({ revision: 3, basisFingerprint: latest.basisFingerprint, analysisId: latest.analysis!.id, note: '保存期间继续输入的最新说明' })
    await expect(note).toHaveValue('保存期间继续输入的最新说明')
    await expect(completed).toHaveCount(0)
    await panel.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理', exact: true }).check()
    await page.getByRole('button', { name: '确认选型、清单与预留', exact: true }).click()
    await expect.poll(async () => (await selection()).confirmation?.parameters.requestId).toBe(planned.id)
    expect((await read()).draft?.confirmedRevision).toBe(3)
    expect(errors).toEqual([])
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
}
