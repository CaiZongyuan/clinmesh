import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { Page, TestInfo } from '@playwright/test'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientDrgAgentSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { modelUsageListSchema } from '@clinmesh/contracts/model-usage'
import { expect, openPciAiPatient, type PciAiBrowserApp } from './inpatient-pci-ai.fixture.ts'
import { preparePciAiReview, requestPciAiSurgery } from './inpatient-pci-ai.journey.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

const money = (fen: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(fen / 100)
const actions = (page: Page) => page.getByRole('region', { name: '当前操作', exact: true })
const scenes: Record<string, string> = { request: 'req', selection: 'sel', materials: 'mat', preparation: 'prep', nurse: 'prep', ready: 'ready', start: 'ready', running: 'run', completion: 'done', postoperative: 'post' }

async function captureFactory(page: Page, info: TestInfo, origin: string, screenshots: boolean) {
  const root = page.locator('.clinmesh-web-root'), surface = await root.evaluate(element => element.getRootNode() instanceof ShadowRoot)
  await root.evaluate(element => { element.dataset.fontSize = 'standard' })
  await expect.poll(() => root.locator('input:visible').first().evaluate(element => getComputedStyle(element).fontSize)).toBe('14px')
  // 本机原型不进入 Git；CI 仍执行下方可观察的界面合同。
  const prototype = await readFile(new URL('../../../.prototypes/2026-11-13-surgery-flow/surgery-flow.html', import.meta.url), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  let reference: Page | null = null
  if (screenshots && prototype && !surface) {
    reference = await page.context().newPage()
    await reference.route(`${origin}/surgery-flow-prototype`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: prototype }))
    await reference.setViewportSize({ width: 1800, height: 1200 })
    await reference.goto(`${origin}/surgery-flow-prototype`)
    await expect(reference.locator('.seg[data-key="view"] [data-v="new"]')).toHaveAttribute('aria-pressed', 'true')
  }
  const evidence: unknown[] = []
  return {
    async capture(stage: string, nextAction?: string) {
      const captureStage = screenshots && (!process.env.CLINMESH_SURGERY_FLOW_CAPTURE_STAGES || process.env.CLINMESH_SURGERY_FLOW_CAPTURE_STAGES.split(',').includes(stage))
      if (nextAction) {
        await expect(page.locator('.clinmesh-inpatient-turn')).toContainText(nextAction)
        await expect(actions(page).getByRole('button', { name: nextAction, exact: true })).toBeVisible()
      }
      await expect(page.locator('.clinmesh-inpatient-head .clinmesh-inpatient-drg-progress')).toBeVisible()
      if (process.env.CLINMESH_SURGERY_FLOW_FULL_MATRIX !== '1' && !['running', 'completion'].includes(stage)) return
      for (const width of [1600, 1280]) for (const theme of ['light', 'dark']) {
        const height = width === 1600 ? 1000 : 800, hostWidth = surface ? width - 56 - (width === 1600 ? 443 : 398) : width
        await page.setViewportSize({ width, height })
        await root.evaluate((element, input) => {
          element.classList.toggle('dark', input.theme === 'dark'); element.dataset.theme = input.theme; element.dataset.fontSize = 'standard'
          if (input.surface) {
            const host = (element.getRootNode() as ShadowRoot).host as HTMLElement
            host.style.width = `${input.hostWidth}px`; host.style.marginLeft = '56px'
            element.style.width = '100%'; element.style.marginLeft = ''
          }
          for (const child of element.querySelectorAll<HTMLElement>('*')) if (getComputedStyle(child).overflowY === 'auto') child.scrollTop = 0
        }, { theme, surface, hostWidth })
        await expect.poll(() => root.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(hostWidth)
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        const layout = await root.evaluate(element => {
          const visible = (item: Element) => { const r = item.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(item).visibility !== 'hidden' }
          const regions = Array.from(element.querySelectorAll<HTMLElement>('.clinmesh-inpatient-head,.clinmesh-card-main,.clinmesh-inpatient-stage,[data-slot="dialog-content"],[role="dialog"][aria-label="开始手术"]')).filter(visible).map(item => {
            const r = item.getBoundingClientRect(); return { modal: item.getAttribute('role') === 'dialog', name: item.getAttribute('aria-label') ?? item.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom, clientWidth: item.clientWidth, scrollWidth: item.scrollWidth }
          })
          const steps = Array.from(element.querySelectorAll<HTMLElement>('[role="region"],section[aria-label]')).filter(item => visible(item) && ['选型参数', '手术耗材', '术前准备'].includes(item.getAttribute('aria-label') ?? '')).map(item => ({ name: item.getAttribute('aria-label'), y: item.getBoundingClientRect().top }))
          const text = element.querySelector('.clinmesh-inpatient-turn')?.textContent
          const bounds = element.getBoundingClientRect()
          return { regions, steps, turn: text, rootLeft: bounds.left, rootRight: bounds.right, rootOverflow: element.scrollWidth - element.clientWidth }
        })
        const issues = layout.regions.filter(item => item.scrollWidth > item.clientWidth + 1).map(item => `horizontal overflow: ${JSON.stringify(item)}`)
        if (layout.rootOverflow > 1) issues.push(`root overflow ${layout.rootOverflow}`)
        for (const modal of layout.regions.filter(item => item.modal)) if (modal.top < -1 || modal.bottom > height + 1 || surface && (modal.left < layout.rootLeft - 1 || modal.right > layout.rootRight + 1)) issues.push(`modal outside viewport: ${JSON.stringify(modal)}`)
        const record = { stage, width, theme, hostWidth, surface, ...layout, issues, prototypeSha256: prototype ? createHash('sha256').update(prototype).digest('hex') : null }
        evidence.push(record)
        if (captureStage) {
          const path = info.outputPath(`surgery-flow-${stage}-${width}-${theme}.png`)
          await page.screenshot({ path, animations: 'disabled' })
          await info.attach(`surgery-flow-${stage}-${width}-${theme}`, { path, contentType: 'image/png' })
        }
        expect(issues, JSON.stringify(record)).toEqual([])
        if (['selection', 'materials', 'running', 'completion', 'postoperative'].includes(stage)) {
          const headBefore = await page.locator('.clinmesh-inpatient-head').boundingBox()
          const scrolls = await root.evaluate(element => {
            const modal = Array.from(element.querySelectorAll<HTMLElement>('[data-slot="dialog-content"]')).find(item => item.getBoundingClientRect().width > 0 && getComputedStyle(item).visibility !== 'hidden' && !item.hasAttribute('data-closed'))
            return Array.from(element.querySelectorAll<HTMLElement>('*')).filter(item => getComputedStyle(item).overflowY === 'auto' && item.scrollHeight > item.clientHeight && (modal ? modal.contains(item) : item.classList.contains('clinmesh-card-content') || item.getAttribute('role') === 'tabpanel' && item.getBoundingClientRect().width > 0)).map(item => {
              item.scrollTop = item.scrollHeight
              return { scrollTop: item.scrollTop, height: item.clientHeight, scrollHeight: item.scrollHeight }
            })
          })
          if (scrolls.length) {
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
            if (captureStage) {
              const detail = info.outputPath(`surgery-flow-${stage}-${width}-${theme}-detail.png`)
              await page.screenshot({ path: detail, animations: 'disabled' })
              await info.attach(`surgery-flow-${stage}-${width}-${theme}-detail`, { path: detail, contentType: 'image/png' })
            }
            expect(await page.locator('.clinmesh-inpatient-head').boundingBox()).toEqual(headBefore)
          }
        }
        if (reference && captureStage) {
          await reference.locator(`.seg[data-key="width"] [data-v="${width}"]`).click()
          await reference.locator(`.seg[data-key="theme"] [data-v="${theme}"]`).click()
          await reference.locator(`.seg[data-key="scene"] [data-v="${scenes[stage]}"]`).click()
          if (stage === 'nurse') {
            await reference.locator('[data-act="opt"][data-bind="consent"]').first().click()
            await reference.locator('[data-act="consent-ok"]').click()
          }
          if (stage === 'start') await reference.locator('[data-act="start-open"]').click()
          const referencePath = info.outputPath(`prototype-${stage}-${width}-${theme}.png`)
          await reference.locator('.surface').screenshot({ path: referencePath, animations: 'disabled' })
          await info.attach(`prototype-${stage}-${width}-${theme}`, { path: referencePath, contentType: 'image/png' })
        }
      }
      await page.setViewportSize({ width: 1600, height: 1000 })
      await root.evaluate(element => {
        element.classList.remove('dark'); element.dataset.theme = 'light'; element.style.width = ''; element.style.marginLeft = ''
        const shadow = element.getRootNode()
        if (shadow instanceof ShadowRoot) { const host = shadow.host as HTMLElement; host.style.width = '100%'; host.style.marginLeft = '' }
      })
    },
    async close() {
      await reference?.close()
      const path = info.outputPath('surgery-flow-geometry.json')
      await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`)
      await info.attach('surgery-flow-geometry', { path, contentType: 'application/json' })
    },
  }
}

/** 同一合成病例逐阶段验收；模型只由受控 HTTP Provider 返回。 */
export async function runSurgeryFlowJourney(page: Page, app: PciAiBrowserApp, info: TestInfo) {
  const { stay, planned, panel, stepOne, errors, catalog } = await preparePciAiReview(page, app), f = app.fixture
  const capture = await captureFactory(page, info, app.origin, process.env.CLINMESH_SURGERY_FLOW_CAPTURE === '1')
  try {
    await page.getByRole('button', { name: '助手自动跟进', exact: true }).click()
    await page.getByRole('dialog', { name: '开启助手自动跟进', exact: true }).getByRole('button', { name: '开启', exact: true }).click()
    await expect(page.getByRole('button', { name: '助手自动跟进', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '申请手术', exact: true }).click()
    const request = page.getByRole('dialog', { name: '申请手术', exact: true })
    await expect(request.getByLabel('手术申请理由', { exact: true })).toHaveValue(/已确认冠状动脉/)
    await expect(request.getByText('助手', { exact: true })).toBeVisible()
    await capture.capture('request')
    await request.getByRole('button', { name: '取消', exact: true }).click()
    expect(app.calls.filter(call => call.kind === 'request-reason')).toHaveLength(1)

    await stepOne.getByRole('button', { name: '修改', exact: true }).click()
    await capture.capture('selection', '确认选型参数')
    await actions(page).getByRole('button', { name: '确认选型参数', exact: true }).click()
    await expect(panel).toContainText('指南参考')
    await capture.capture('materials', '确认手术耗材')
    const positions = await page.getByRole('region', { name: '住院手术', exact: true }).getByRole('region').evaluateAll(elements => elements.filter(item => ['选型参数', '手术耗材', '术前准备'].includes(item.getAttribute('aria-label') ?? '')).map(item => ({ label: item.getAttribute('aria-label'), y: item.getBoundingClientRect().top })))
    expect(positions.map(item => item.label)).toEqual(['选型参数', '手术耗材', '术前准备'])
    expect(positions[0]!.y).toBeLessThan(positions[1]!.y); expect(positions[1]!.y).toBeLessThan(positions[2]!.y)
    await actions(page).getByRole('button', { name: '确认手术耗材', exact: true }).click()
    await expect(actions(page).getByRole('button', { name: '确认手术知情同意书已签', exact: true })).toBeEnabled()
    await openPciAiPatient(page, app, 'inpatient-doctor', stay.patientName); await selectInpatientStage(page, '手术')
    await expect(page.getByText('选型已变化', { exact: false })).toHaveCount(0)
    await actions(page).getByRole('button', { name: '确认手术知情同意书已签', exact: true }).click()
    const preparation = page.getByRole('region', { name: '术前准备', exact: true })
    await preparation.getByRole('button', { name: '患者本人已签署手术知情同意书', exact: true }).click()
    await capture.capture('preparation', '确认手术知情同意书已签')
    await actions(page).getByRole('button', { name: '确认手术知情同意书已签', exact: true }).click()
    await capture.capture('nurse', '等病区护士术前核对')
    await openPciAiPatient(page, app, 'ward-nurse', stay.patientName); await selectInpatientStage(page, '手术')
    await expect(page.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组', exact: true })).toHaveCount(0)
    await page.getByLabel('术前核对说明', { exact: true }).fill('合成组合验收术前核对')
    await actions(page).getByRole('button', { name: '术前核对', exact: true }).click()
    await expect(page.getByRole('region', { name: '当前手术计划', exact: true })).toContainText('已就绪')
    await openPciAiPatient(page, app, 'inpatient-doctor', stay.patientName); await selectInpatientStage(page, '手术')
    await capture.capture('ready', '开始手术')
    await actions(page).getByRole('button', { name: '开始手术', exact: true }).click()
    const start = page.getByRole('dialog', { name: '开始手术', exact: true })
    await expect(start.getByRole('button', { name: '开始手术', exact: true })).toBeDisabled()
    await start.getByRole('button', { name: '术前准备已完成，按计划开始手术', exact: true }).click()
    await capture.capture('start')
    await start.getByRole('button', { name: '开始手术', exact: true }).click()
    const live = page.getByRole('region', { name: '本台耗材', exact: true }), wire = live.getByRole('row', { name: /合成院内 冠脉导丝/ })
    await wire.getByRole('button', { name: /^用 1 根 / }).click()
    await expect(live.getByRole('row', { name: /冠脉导丝.*× 1根/ })).toBeVisible()
    expect(app.calls.filter(call => call.kind === 'intraoperative')).toHaveLength(0)
    await wire.getByRole('button', { name: /^再用 1 根 / }).click()
    await expect(live.getByRole('button', { name: '登记这笔', exact: true })).toBeDisabled()
    await live.getByRole('button', { name: '分支保护', exact: true }).click()
    await live.getByRole('button', { name: '登记这笔', exact: true }).click()
    await expect(live.getByText('本笔超出已确认计划，登记依据为分支保护，其余计划用量仍按已确认清单核对。', { exact: false })).toBeVisible()
    expect(app.calls.filter(call => call.kind === 'intraoperative')).toEqual([
      { kind: 'intraoperative', phase: 'intraoperative', feature: 'inpatient_drg_recommendation' },
      { kind: 'intraoperative', phase: 'intraoperative', feature: 'inpatient_drg_verification' },
    ])
    const agent = await f.read('inpatient-doctor', `${stay.path}/drg/agent`, inpatientDrgAgentSchema)
    const review = agent.intraoperativeReviews.find(item => item.requestId === planned.id)!
    const usage = await f.read('inpatient-doctor', `/api/model-usage/requests?caseId=${stay.admissionId}&taskId=${review.taskId}`, modelUsageListSchema)
    expect(usage.items.map(item => item.context.stage).sort()).toEqual(['intraoperative-generation', 'intraoperative-verification'])
    const saved = (await f.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)).inProgress.find(item => item.requestId === planned.id)!
    expect(saved.materialHistory).toEqual([expect.objectContaining({ quantity: 1, note: expect.stringContaining('按计划') }), expect.objectContaining({ quantity: 1, note: '分支保护', reservationId: null })])
    const reservations = await f.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
    expect(reservations.reservations.find(item => item.requestId === planned.id && item.materialId === 'hospital-material-pci-guidewire')).toMatchObject({ consumedQuantity: 1, remainingQuantity: 0 })
    await expect(page.locator('.clinmesh-inpatient-drg-progress-amount')).toContainText(`已用 ${money(agent.costs!.components.formalChargesFen)}`)
    for (const id of ['hospital-material-pci-guiding-catheter', 'hospital-material-pci-balloon', 'hospital-material-pci-stent']) {
      const material = catalog.materials.find(item => item.id === id)
      if (!material || !('chargeDefinition' in material)) throw new Error(`Missing synthetic material ${id}`)
      await live.getByRole('row').filter({ has: page.getByText(material.display, { exact: true }) }).getByRole('button', { name: /^用 1 / }).click()
      await expect(live.getByRole('row', { name: `${material.display} × 1${material.chargeDefinition.unit}`, exact: true })).toBeVisible()
    }
    const completeUse = (await f.read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)).inProgress.find(item => item.requestId === planned.id)!
    expect(completeUse.materialHistory).toHaveLength(5)
    await capture.capture('running')
    await actions(page).getByRole('button', { name: '核实最终耗材并完成手术', exact: true }).click()
    const completion = page.getByRole('dialog', { name: '核实最终耗材并完成手术', exact: true })
    await expect(completion).toContainText('已登记量默认作为最终用量')
    await expect(completion).toContainText('多用 1')
    await expect(completion.getByLabel('核实说明', { exact: true })).not.toHaveValue('')
    await expect(completion.getByLabel('核实说明', { exact: true })).toHaveValue(/分支保护/)
    await expect(completion.getByLabel('核实说明', { exact: true })).not.toHaveValue(/按计划 ·/)
    await expect(completion.getByRole('region', { name: '本次差额', exact: true })).toContainText('耗材差额合计 ¥0.00')
    await expect(completion.getByRole('button', { name: '确认完成手术', exact: true })).toBeEnabled()
    await capture.capture('completion')
    await completion.getByRole('button', { name: '确认完成手术', exact: true }).click()
    const postoperative = page.getByRole('region', { name: '术后核查与责任交接', exact: true })
    await expect(postoperative.getByRole('button', { name: '一次全部确认', exact: true })).toBeEnabled()
    await expect(postoperative.getByRole('list', { name: '术后核查清单', exact: true }).getByRole('listitem')).toHaveCount(1)
    await expect(postoperative.getByText(/^阶段正式收费|^含医生已有后续治疗计划|^术后分析已就绪/)).toHaveCount(0)
    const progress = page.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组', exact: true })
    await expect(progress).toContainText('术后预计 FM39')
    await expect(progress).toContainText('待确认主操作')
    await expect(progress).toContainText('支付参考 ¥12,000.00')
    await capture.capture('postoperative')
    const finding = postoperative.getByRole('listitem')
    await finding.getByRole('button', { name: '看术中登记', exact: true }).click()
    const source = page.getByRole('dialog').filter({ has: page.getByRole('region', { name: '本项术中登记', exact: true }) })
    await expect(source.getByRole('region', { name: '本项术中登记', exact: true })).toContainText('分支保护')
    await source.getByRole('button', { name: '关闭', exact: true }).click()
    await postoperative.getByRole('button', { name: '核查依据与历史', exact: true }).click()
    const history = page.getByRole('dialog', { name: '核查依据与历史', exact: true })
    await expect(history).toContainText('阶段正式收费')
    await history.getByRole('button', { name: '关闭', exact: true }).click()
    await finding.getByRole('button', { name: /^修改处理说明 / }).click()
    const disposition = finding.getByRole('textbox', { name: '待办处理说明', exact: true })
    await disposition.fill('')
    await expect(postoperative.getByRole('button', { name: '一次全部确认', exact: true })).toBeDisabled()
    await disposition.fill('分支保护已按本笔登记核实，无需后续处理。')
    await postoperative.getByRole('button', { name: '一次全部确认', exact: true }).click()
    await expect.poll(async () => (await f.read('inpatient-doctor', `${stay.path}/drg/review`, inpatientDrgReviewSchema)).todos.filter(item => item.requestId === planned.id && item.ownerRole === 'inpatient-doctor' && ['pending', 'in-progress'].includes(item.status)), { timeout: 30_000 }).toHaveLength(0)
    await expect(postoperative.getByRole('button', { name: '一次全部确认', exact: true })).toHaveCount(0)
    await expect(postoperative.getByRole('textbox', { name: '待办处理说明', exact: true })).toHaveCount(0)
    expect((await f.read('inpatient-doctor', `${stay.path}/drg/review`, inpatientDrgReviewSchema)).todos.find(item => item.requestId === planned.id)?.reason).toBe('分支保护已按本笔登记核实，无需后续处理。')
    await expect(page.getByRole('tab', { name: '手术', exact: true })).toHaveAccessibleDescription(/待办 0 项/)
    await expect(page.getByRole('tab', { name: '手术', exact: true }).getByText(/^\d+$/)).toHaveCount(0)
    await requestPciAiSurgery(page, app, stay.path, '36.0700', '合成下一台手术计划')
    await expect(postoperative).toHaveCount(0)
    expect(errors).toEqual([])
  } finally { await capture.close() }
}
