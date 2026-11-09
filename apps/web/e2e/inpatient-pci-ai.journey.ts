import type { Locator, Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientGuidelineAdviceListSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { modelUsageListSchema, modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { expect, openPciAiPatient, preparePciAiPatient, test, type PciAiBrowserApp } from './inpatient-pci-ai.fixture.ts'
import { expectCompletedSurgeryPreparation, selectInpatientStage } from './inpatient-ui.ts'

export async function requestPciAiSurgery(page: Page, app: PciAiBrowserApp, path: string, code: string, reason: string) {
  await page.getByRole('button', { name: '申请手术', exact: true }).first().click()
  await page.getByLabel('计划术式', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(code) }).click()
  await page.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-08-24T15:00')
  await page.getByLabel('手术申请理由', { exact: true }).fill(reason)
  await page.getByRole('button', { name: '提交手术申请', exact: true }).click()
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
  const prepareSurgery = async (reason: string) => {
    let plan = page.getByRole('region', { name: '住院手术', exact: true }).locator('article').filter({ hasText: reason })
    await expect(plan.getByRole('button', { name: '确认已签', exact: true })).toBeEnabled()
    await open('ward-nurse'); await stage('手术')
    plan = page.getByRole('region', { name: '住院手术', exact: true }).locator('article').filter({ hasText: reason })
    await plan.getByLabel('术前核对说明', { exact: true }).fill('已核对合成术前准备')
    await page.getByRole('button', { name: '术前核对', exact: true }).click()
    const preopTime = await expectCompletedSurgeryPreparation(plan, '术前核对', '病区护士')
    const preop = (await f.read('ward-nurse', `${stay.path}/surgeries`, inpatientSurgerySchema)).requests.find(item => item.reason === reason)!.preopCheck!
    await expect(preopTime).toHaveAttribute('datetime', preop.recordedAt)
    await open(); await stage('手术')
    plan = page.getByRole('region', { name: '住院手术', exact: true }).locator('article').filter({ hasText: reason })
    await plan.getByRole('button', { name: '确认已签', exact: true }).click()
    await plan.getByLabel('签署说明', { exact: true }).fill('已确认合成知情同意')
    await page.getByRole('button', { name: '确认手术知情同意书已签', exact: true }).click()
    await expect(plan).toContainText('已就绪')
    await expect(page.getByRole('button', { name: '开始手术逐笔登记', exact: true })).toBeEnabled()
    return plan
  }
  expect(app.calls).toEqual([])
  await open(); await stage('手术')
  const angiographyRequest = await requestPciAiSurgery(page, app, stay.path, '88.5500', '合成AI验收诊断造影')
  await expect.poll(async () => (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === angiographyRequest.id)?.status).toBe('succeeded')
  expect(app.calls).toEqual([{ kind: 'material', phase: 'angiography', feature: 'inpatient_drg_recommendation' }, { kind: 'material', phase: 'angiography', feature: 'inpatient_drg_verification' }])
  await prepareSurgery(angiographyRequest.reason)
  await page.getByRole('button', { name: '整台补录', exact: true }).click()
  const batch = page.getByRole('dialog', { name: '整台补录', exact: true })
  await batch.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${angiography.coding.code} · ${angiography.coding.display}`, exact: true }).click()
  await batch.getByLabel('补录依据', { exact: true }).fill('合成AI验收诊断造影实际执行')
  const beforeReport = [...app.calls]
  await batch.getByRole('button', { name: '记录实际手术', exact: true }).click()
  const reports = () => f.read('inpatient-doctor', `${stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)
  await expect.poll(async () => (await reports()).reports[0]?.status).toBe('final')
  const report = (await reports()).reports[0]!
  expect(report.measurements.map(item => item.value)).toEqual([12, 3, 3])
  expect(app.calls).toEqual(beforeReport)
  const angiographyExecution = (await f.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)).executions.find(item => item.requestId === angiographyRequest.id)!
  await f.confirmMainProcedure(stay, angiographyExecution.id)
  const planned = await requestPciAiSurgery(page, app, stay.path, '36.0700', '合成AI验收PCI计划')
  const selection = () => f.read('inpatient-doctor', `${stay.path}/pci-selection`, inpatientPciSelectionSchema)
  expect((await selection()).confirmation).toBeNull()
  const stepOne = page.getByRole('region', { name: '选型参数', exact: true })
  await expect(stepOne).toContainText('已按冠脉造影报告预填病变测量，请逐项核对后确认。')
  await expect(stepOne.getByLabel('靶病变部位', { exact: true })).toHaveValue('LAD 中段')
  await expect(stepOne.getByLabel('病变长度 (mm)', { exact: true })).toHaveValue('12')
  await expect(stepOne.getByLabel('近端参考管径 (mm)', { exact: true })).toHaveValue('3')
  await expect(stepOne.getByLabel('远端参考管径 (mm)', { exact: true })).toHaveValue('3')
  await expect(stepOne).toContainText('定量冠脉造影（合成）')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认选型参数', exact: true }).click()
  await expect(stepOne).toContainText('你 · 已确认')
  const panel = page.getByRole('region', { name: '手术耗材', exact: true })
  await expect.poll(async () => (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === planned.id)?.status).toBe('succeeded')
  await expect(panel).toContainText('指南参考')
  await expect(panel).toContainText('做完手术后预计病组 FM39')
  return { stay, planned, panel, stepOne, selection, errors, writes, prepareSurgery, catalog, angiographyRequest }
}

export async function preparePciAiReview(page: Page, app: PciAiBrowserApp) {
  const prepared = await preparePciAiPlan(page, app)
  const { stay, planned, panel, angiographyRequest } = prepared, f = app.fixture
  await expect.poll(async () => (await f.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)?.status).toBe('succeeded')
  await expect(panel).toContainText('指南参考')
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
  const f = app.fixture, pci = planned.plannedProcedure
  const estimate = (await f.read('inpatient-doctor', `${stay.path}/material-estimates`, inpatientMaterialEstimatesSchema)).estimates.find(item => item.requestId === planned.id)!
  expect((estimate.analysis?.costExplanation ?? '').trim()).not.toBe('')
  await expect(panel).toContainText('做完手术后预计病组 FM39')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认并预留', exact: true }).click()
  await expect.poll(async () => (await selection()).confirmation?.parameters.requestId).toBe(planned.id)
  const reservations = await f.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(reservations.reservations.filter(item => item.requestId === planned.id && item.status === 'reserved')).toHaveLength(4)
  expect(writes.filter(path => path.endsWith('/material-estimates/confirm'))).toHaveLength(1)
  expect(writes.filter(path => path.endsWith('/pci-selection/confirm'))).toHaveLength(0)
  expect((await f.read('inpatient-doctor', `${stay.path}/drg/followup`, inpatientDrgFollowupSchema)).task).toBeNull()
  await prepareSurgery(planned.reason)
  await page.getByRole('button', { name: '开始手术逐笔登记', exact: true }).click()
  const startDialog = page.getByRole('dialog', { name: '开始手术', exact: true })
  await startDialog.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${pci.coding.code} · ${pci.coding.display}`, exact: true }).click()
  await startDialog.getByLabel('开始说明', { exact: true }).fill('开始合成PCI手术')
  await startDialog.getByRole('button', { name: '开始手术', exact: true }).click()
  const live = page.getByRole('region', { name: '本台耗材', exact: true })
  const wire = catalog.materials.find(item => item.id === 'hospital-material-pci-guidewire')!
  const entry = live.getByRole('region', { name: '登记本笔使用', exact: true })
  await entry.getByLabel('耗材', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(`^${wire.display}`) }).click()
  await entry.getByLabel('数量', { exact: true }).fill('2')
  await entry.getByRole('button', { name: '额外使用，不消耗预留', exact: true }).click()
  await entry.getByLabel('依据', { exact: true }).fill('核对额外导丝实际用途')
  const beforeUse = [...app.calls]
  await entry.getByRole('button', { name: '登记这笔', exact: true }).click()
  await expect(live.getByRole('row', { name: /导丝/ })).toContainText('2 根')
  await expect(live.getByRole('row', { name: /导丝/ })).toContainText('额外使用')
  await f.runtime.dispatchPending()
  expect(app.calls).toEqual(beforeUse)
  await page.getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
  const completeDialog = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
  await completeDialog.getByLabel('核实说明', { exact: true }).fill('合成PCI最终用量核对，仅导丝使用两根')
  await page.getByRole('button', { name: '预览本次差额', exact: true }).click()
  await page.getByRole('button', { name: '确认完成手术', exact: true }).click()
  await expect(page.getByRole('region', { name: '最终耗材', exact: true })).toContainText(wire.display)
  const review = page.getByRole('region', { name: '术后核查与责任交接', exact: true })
  await expect(review).toBeVisible()
  await expect(review).toContainText('负责岗位：住院医生')
  await expect(page.getByRole('tab', { name: '手术', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect((await f.read('inpatient-doctor', `${stay.path}/drg/review`, inpatientDrgReviewSchema)).todos.some(item => item.kind === 'extra-use')).toBe(true)
  expect(app.calls).toEqual(beforeUse)
  expect(errors).toEqual([])
}

export async function runPciAiConfirmHandoffJourney(page: Page, app: PciAiBrowserApp) {
  const { stay, planned, selection, prepareSurgery } = await preparePciAiReview(page, app)
  let release!: () => void, committed!: () => void
  const receipt = new Promise<void>(resolve => { release = resolve })
  const confirmed = new Promise<void>(resolve => { committed = resolve })
  await page.route(`**${stay.path}/material-estimates/confirm`, async route => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    committed()
    await receipt
    await route.fulfill({ response })
  })
  const post = page.request.post
  let signIns = 0, preparation: Promise<Locator> | undefined
  try {
    await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认并预留', exact: true }).click()
    await confirmed
    expect((await selection()).confirmation?.parameters.requestId).toBe(planned.id)
    const plan = page.getByRole('region', { name: '住院手术', exact: true }).locator('article').filter({ hasText: planned.reason })
    await expect(plan.getByRole('button', { name: '确认已签', exact: true })).toBeDisabled()
    page.request.post = <T = unknown>(url: string, options?: Parameters<typeof post>[1]) => {
      if (url.endsWith('/api/auth/sign-in/email')) signIns++
      return (post<T>).call(page.request, url, options)
    }
    preparation = prepareSurgery(planned.reason)
    expect(signIns).toBe(0)
    release()
    const ready = await preparation
    expect(signIns).toBe(2)
    await expect(ready).toContainText('已就绪')
    await expect(page.getByRole('button', { name: '开始手术逐笔登记', exact: true })).toBeEnabled()
    await expect(page.getByRole('region', { name: '待确认操作', exact: true })).toHaveCount(0)
  } finally {
    release()
    await preparation?.catch(() => undefined)
    page.request.post = post
    await page.unrouteAll({ behavior: 'wait' })
  }
}

export async function runPciAiMissingUnitJourney(page: Page, app: PciAiBrowserApp) {
  const { stay, planned, stepOne, selection } = await preparePciAiReview(page, app)
  const read = async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  await stepOne.getByRole('button', { name: '修改', exact: true }).click()
  await stepOne.getByLabel('病变长度 (mm)', { exact: true }).fill('30')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认选型参数', exact: true }).click()
  await expect.poll(async () => (await read()).status).toBe('stale')
  const draft = (await selection()).drafts!.find(item => item.requestId === planned.id)!
  expect(draft.parameters.measurements.find(item => item.kind === 'lesion-length')?.value).toBe(30)
  const report = (await app.fixture.read('inpatient-doctor', `${stay.path}/angiography-reports`, inpatientAngiographyReportsSchema)).reports.find(item => item.id === draft.reportId)!
  expect(report.measurements.find(item => item.kind === 'lesion-length')?.unit).toBe('mm')
}

export async function runPciAiFrozenJourney(page: Page, app: PciAiBrowserApp) {
  const { stay, planned, panel, stepOne, prepareSurgery } = await preparePciAiReview(page, app)
  const read = async () => (await app.fixture.read('inpatient-doctor', `${stay.path}/guideline-advice`, inpatientGuidelineAdviceListSchema)).advice.find(item => item.requestId === planned.id)!
  const original = await read(), calls = [...app.calls]
  await prepareSurgery(planned.reason)
  await page.getByRole('button', { name: '开始手术逐笔登记', exact: true }).click()
  const startDialog = page.getByRole('dialog', { name: '开始手术', exact: true })
  await startDialog.getByLabel('实际术式', { exact: true }).click()
  await page.getByRole('option', { name: `${planned.plannedProcedure.coding.code} · ${planned.plannedProcedure.coding.display}`, exact: true }).click()
  await startDialog.getByLabel('开始说明', { exact: true }).fill('开始手术验证术前确认只读')
  const started = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${stay.path}/surgeries/start`)
  await startDialog.getByRole('button', { name: '开始手术', exact: true }).click()
  expect((await started).status()).toBe(200)
  await expect.poll(async () => (await read()).status).toBe('frozen')
  const posts: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith(stay.path)) posts.push(request.url()) })
  await expect(stepOne).toHaveCount(0)
  await expect(panel).toHaveCount(0)
  await expect(page.getByRole('region', { name: '本台耗材', exact: true })).toContainText('手术进行中')
  expect((await read()).result).toEqual(original.result)
  expect(posts).toEqual([])
  expect(app.calls).toEqual(calls)
}

export async function runPciAiMenuFocusJourney(page: Page, app: PciAiBrowserApp) {
  const { stay } = await preparePciAiReview(page, app)
  const confirm = page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认并预留', exact: true })
  await expect(confirm).toBeEnabled()
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu')
  const ownsFocus = () => menu.evaluate(element => {
    const root = element.getRootNode()
    return element.contains(root instanceof ShadowRoot ? root.activeElement : element.ownerDocument.activeElement)
  })
  await expect.poll(ownsFocus).toBe(true)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**${stay.path}/material-estimates`, async route => { await held; await route.continue() })
  try {
    release()
    await expect(confirm).toBeEnabled()
    await expect.poll(ownsFocus).toBe(true)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(confirm).toBeEnabled()
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
      const issues: string[] = [], regions: Array<{ name: string; width: number; clientWidth: number; scrollWidth: number }> = []
      for (const [name, region] of [
        ['stepOne', page.getByRole('region', { name: '选型参数', exact: true })],
        ['stepTwo', panel],
      ] as const) {
        await region.scrollIntoViewIfNeeded()
        const bounds = await region.evaluate(element => {
          const rect = element.getBoundingClientRect(), main = element.closest('.clinmesh-card-main')!.getBoundingClientRect()
          return { width: rect.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, left: rect.left, right: rect.right, mainLeft: main.left, mainRight: main.right }
        })
        regions.push({ name, width: bounds.width, clientWidth: bounds.clientWidth, scrollWidth: bounds.scrollWidth })
        if (bounds.width <= 0 || bounds.scrollWidth > bounds.clientWidth + 1 || bounds.left < bounds.mainLeft - 1 || bounds.right > bounds.mainRight + 1) issues.push(`${name}: ${JSON.stringify(bounds)}`)
      }
      const action = page.getByRole('region', { name: '当前操作', exact: true })
      await expect(action.getByRole('button', { name: '确认并预留', exact: true })).toBeEnabled()
      const bar = await action.boundingBox(), main = await workspace.locator('.clinmesh-card-main').boundingBox()
      if (!bar || !main || bar.x < main.x - 1 || bar.x + bar.width > main.x + main.width + 1 || bar.y < 0 || bar.y + bar.height > 901) issues.push(`action: ${JSON.stringify({ bar, main })}`)
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
  await note.fill('保存期间继续输入的最新说明')
  await expect(note).toHaveValue('保存期间继续输入的最新说明')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认并预留', exact: true }).click()
  await expect.poll(async () => (await selection()).confirmation?.parameters.requestId).toBe(planned.id)
  const latest = await read()
  expect(latest.draft?.note).toBe('保存期间继续输入的最新说明')
  expect(latest.draft?.confirmedRevision).toBe(2)
  expect(errors).toEqual([])
}
