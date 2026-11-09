import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Locator } from '@playwright/test'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { expect, test, loginPciBrowser } from './inpatient-pci.fixture.ts'
import { selectInpatientStage } from './inpatient-ui.ts'

const output = process.env.CLINMESH_CAPTURE_ISSUE400
const before = process.env.CLINMESH_CAPTURE_ISSUE400_PHASE === 'before'
test.skip(!output, '仅在显式请求实机证据时运行')

test('住院医生减负实机同病例对比', async ({ page, pciApp: app }) => {
  test.setTimeout(before ? 180_000 : 300_000)
  const directory = output!
  await mkdir(directory, { recursive: true })
  const fixture = app.fixture
  const stay = await fixture.preparePciAdmission()
  const catalog = await fixture.read('inpatient-doctor', '/api/his/v1/inpatient/investigation-catalog', inpatientInvestigationCatalogSchema)
  // 通过公开 Command 准备临床事实，截图和阅读/弹窗操作始终来自生产 Web。
  for (const item of catalog.items.filter(item => item.id.startsWith('hospital-lab-pci-')).slice(0, 4)) {
    const admission = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const response = await fixture.request('inpatient-doctor', `${stay.path}/investigations/issue`, {
      encounterVersion: admission.admission.versionId, catalogVersion: item.version,
      selection: { kind: 'laboratory', catalogItemId: item.id, indicationCode: 'clinical-assessment' },
    })
    expect(response.status).toBe(200)
    const issued = inpatientInvestigationResponseSchema.parse(await response.json()).data.laboratoryRequests.find(request => request.catalogItemId === item.id)!
    expect((await fixture.request('ward-nurse', `${stay.path}/investigations/send`, {
      requestId: issued.id, expectedRequestVersion: issued.version, serviceRequestVersion: issued.serviceRequestVersion, taskVersion: issued.taskVersion,
    })).status).toBe(200)
  }
  for (let index = 0; index < 100; index += 1) if (await fixture.runtime.dispatcher.dispatchOnce() === undefined) break
  const reported = await fixture.read('inpatient-doctor', `${stay.path}/investigations`, inpatientInvestigationsSchema)
  expect(reported.laboratoryRequests).toHaveLength(4)
  expect(reported.laboratoryRequests.every(request => request.status === 'reported')).toBe(true)
  await fixture.dispensePciMedications(stay, 'preoperative')
  const detail = await fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`${app.origin}/inpatient`)
  await page.getByLabel('账户邮箱').fill('inpatient-doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(app.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: `查看${detail.admission.patientName}`, exact: true }).click()
  const workspace = page.locator('.clinmesh-card-workspace')
  const activeDialog = page.locator('[data-slot="dialog-content"]:visible')
  const layoutChecks: unknown[] = []
  const shoot = async (scene: string, width: number, variant?: string) => {
    await page.evaluate(() => document.fonts.ready)
    const path = join(directory, variant ? `matrix/${scene}-${width}-${variant}.png` : `${scene}-${width}-light.png`)
    const dialog = activeDialog
    if (!before && await dialog.isVisible()) {
      // 保留真实工作区与弹窗的相对位置；不把全文弹窗缩成整张显示器的缩略图。
      const boxes = [await workspace.boundingBox(), await dialog.boundingBox()].filter(box => box !== null)
      const viewport = page.viewportSize()!
      const x = Math.max(0, Math.min(...boxes.map(box => box.x)))
      const y = Math.max(0, Math.min(...boxes.map(box => box.y)))
      const right = Math.min(viewport.width, Math.max(...boxes.map(box => box.x + box.width)))
      const bottom = Math.min(viewport.height, Math.max(...boxes.map(box => box.y + box.height)))
      await page.screenshot({ path, clip: { x, y, width: right - x, height: bottom - y }, animations: 'disabled' })
    } else await workspace.screenshot({ path, animations: 'disabled' })
  }
  const size = async (width: number) => {
    await page.setViewportSize({ width: width === 1101 ? 1600 : 1280, height: 1000 })
    await workspace.evaluate((element, width) => { element.style.width = `${width}px` }, width)
  }
  const checkWorkspace = async (scene: string) => {
    const result = await workspace.evaluate((element, patientName) => {
      const panels = [element, element.querySelector('.clinmesh-card-main'), element.querySelector('[role="tabpanel"][data-state="active"]')].filter(node => node !== null)
      const queue = element.querySelector('.clinmesh-card-queue')!
      const name = [...queue.querySelectorAll('*')].find(node => node.children.length === 0 && node.textContent === patientName)
      const range = document.createRange()
      if (name) range.selectNodeContents(name)
      const lines = name ? [...range.getClientRects()].map(rect => ({ width: rect.width, height: rect.height })) : []
      return { horizontalOverflow: panels.map(node => node.scrollWidth - node.clientWidth), nameLines: lines,
        nameFont: name ? parseFloat(getComputedStyle(name).fontSize) : 0 }
    }, detail.admission.patientName)
    expect(result.horizontalOverflow.every(value => value <= 1), `${scene}: horizontal overflow`).toBe(true)
    expect(result.nameLines.length, `${scene}: patient name found`).toBeGreaterThan(0)
    expect(result.nameLines.length, `${scene}: patient name must not stack character by character`).toBeLessThanOrEqual(2)
    expect(result.nameLines.every(line => line.width >= result.nameFont * 2)).toBe(true)
    layoutChecks.push({ scene, kind: 'workspace', ...result })
  }
  const checkDialog = async (scene: string) => {
    const dialog = activeDialog
    await expect(dialog).toBeVisible()
    const result = await dialog.evaluate(async element => {
      const rect = element.getBoundingClientRect()
      const scrollers = [...element.querySelectorAll<HTMLElement>('*')].filter(node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1)
      const documentTop = document.scrollingElement?.scrollTop
      for (const node of scrollers) node.scrollTop = node.scrollHeight
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return { rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, viewport: { width: innerWidth, height: innerHeight },
        horizontalOverflow: element.scrollWidth - element.clientWidth,
        scrollers: scrollers.map(node => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, remaining: node.scrollHeight - node.clientHeight - node.scrollTop })),
        documentMoved: documentTop !== document.scrollingElement?.scrollTop }
    })
    expect(result.rect.left).toBeGreaterThanOrEqual(0)
    expect(result.rect.top).toBeGreaterThanOrEqual(0)
    expect(result.rect.right).toBeLessThanOrEqual(result.viewport.width + 1)
    expect(result.rect.bottom).toBeLessThanOrEqual(result.viewport.height + 1)
    expect(result.horizontalOverflow).toBeLessThanOrEqual(1)
    expect(result.scrollers.every(node => node.remaining <= 1)).toBe(true)
    expect(result.documentMoved).toBe(false)
    const close = dialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name: /^(关闭|取消|Close|Cancel)$/ }).last()
    await expect(close).toBeInViewport()
    layoutChecks.push({ scene, kind: 'dialog', ...result })
  }
  const modal = async (entry: Locator, scene: string, width: number, variant?: string) => {
    await entry.click()
    await expect(activeDialog).toBeVisible()
    await shoot(scene, width, variant)
    await checkDialog(`${scene}-${width}-${variant ?? 'light-zh-CN'}`)
    await page.keyboard.press('Escape')
    await expect(activeDialog).toHaveCount(0)
    await expect(entry).toBeFocused()
  }
  let locale: 'zh-CN' | 'en-US' = 'zh-CN'
  let theme: 'light' | 'dark' = 'light'
  const preferences = async (nextLocale: typeof locale, nextTheme: typeof theme) => {
    if (locale !== nextLocale) {
      await page.goto(`${app.origin}/settings`)
      await page.getByRole('button', { name: nextLocale === 'zh-CN' ? '中文' : 'English', exact: true }).click()
      locale = nextLocale
      await expect(page.locator('.clinmesh-web-root')).toHaveAttribute('lang', locale)
      await page.goto(`${app.origin}/inpatient`)
      await workspace.locator('.clinmesh-card-queue').getByRole('button').filter({ hasText: detail.admission.patientName }).click()
    }
    if (theme !== nextTheme) {
      await page.getByRole('button', { name: locale === 'zh-CN' ? '用户菜单' : 'User menu', exact: true }).click()
      const label = locale === 'zh-CN' ? nextTheme === 'light' ? '亮色' : '暗色' : nextTheme === 'light' ? 'Light' : 'Dark'
      await page.getByRole('menuitemradio', { name: label, exact: true }).click()
      await page.keyboard.press('Escape')
      theme = nextTheme
      await expect(page.locator('.clinmesh-web-root')).toHaveAttribute('data-theme', theme)
    }
  }
  const stage = async (name: 'investigations' | 'orders' | 'surgery') => {
    const label = ({ investigations: ['检查检验', 'Investigations'], orders: ['诊断医嘱', 'Diagnoses & orders'], surgery: ['手术', 'Surgery'] })[name][locale === 'zh-CN' ? 0 : 1]!
    if (locale === 'zh-CN') return selectInpatientStage(page, label)
    const tab = page.getByRole('tab', { name: label, exact: true, includeHidden: true })
    await expect(tab).toHaveCount(1)
    if (await tab.isVisible()) await tab.click()
    else {
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem').filter({ has: page.getByText(label, { exact: true }) }).click()
    }
    await expect(tab).toHaveAttribute('aria-selected', 'true')
  }
  const matrix = async (capture: (width: number, variant: string) => Promise<void>) => {
    await mkdir(join(directory, 'matrix'), { recursive: true })
    for (const nextLocale of ['zh-CN', 'en-US'] as const) for (const nextTheme of ['light', 'dark'] as const) for (const width of [1101, 826]) {
      await preferences(nextLocale, nextTheme)
      await size(width)
      await capture(width, `${theme}-${locale}`)
    }
    await preferences('zh-CN', 'light')
  }
  for (const width of [1101, 826]) {
    await size(width)
    await selectInpatientStage(page, '检查检验')
    await expect(page.getByRole('region', { name: '住院检查检验', exact: true })).toContainText('待阅')
    await shoot('01-reported', width)
  }
  if (!before) await matrix(async (width, variant) => {
    await stage('investigations')
    await expect(page.getByRole('region', { name: locale === 'zh-CN' ? '住院检查检验' : 'Inpatient investigations', exact: true })).toContainText(locale === 'zh-CN' ? '待阅' : 'Awaiting review')
    await checkWorkspace(`01-reported-${width}-${variant}`)
    await shoot('01-reported', width, variant)
  })
  await selectInpatientStage(page, '检查检验')
  // 逐条点击已阅，让相同事实进入下一阅读状态。
  const investigationPanel = page.getByRole('region', { name: '住院检查检验', exact: true })
  for (let index = 0; index < 4; index += 1) {
    await investigationPanel.getByRole('button', { name: '已阅', exact: true }).first().click()
    await expect(investigationPanel.getByRole('button', { name: '已阅', exact: true })).toHaveCount(3 - index)
  }
  for (const width of [1101, 826]) {
    await size(width)
    await shoot('02-acknowledged', width)
    if (before) {
      const entry = investigationPanel.locator('summary').filter({ hasText: /^查看完整报告$/ }).first()
      await entry.click()
      await shoot('03-full-report', width)
      await entry.click()
    } else {
      await modal(investigationPanel.getByRole('button', { name: '查看全文', exact: true }).first(), '03-full-report', width)
    }
    await selectInpatientStage(page, '诊断医嘱')
    if (before) {
      const entry = page.locator('summary').filter({ hasText: /^执行记录/ })
      await entry.click()
      await shoot('04-executions', width)
      await entry.click()
    } else {
      await modal(page.getByRole('button', { name: /^执行记录/ }).first(), '04-executions', width)
    }
    await selectInpatientStage(page, '手术')
    if (before) await page.locator('summary').filter({ hasText: '新增手术申请' }).click()
    else await page.getByRole('button', { name: /申请手术/ }).first().click()
    const form = before ? workspace : page.getByRole('dialog', { name: /申请手术/ })
    await form.getByLabel('计划手术时间（上海时间）', { exact: true }).fill('2026-08-25T09:00')
    await form.getByLabel('手术申请理由', { exact: true }).fill('合成演示：拟行进一步介入治疗')
    if (before) {
      await shoot('05-new-surgery', width)
      await page.locator('summary').filter({ hasText: '新增手术申请' }).click()
    } else {
      await shoot('05-new-surgery', width)
      await checkDialog(`05-new-surgery-${width}`)
      await page.keyboard.press('Escape')
    }
    await selectInpatientStage(page, '检查检验')
  }
  await fixture.executePci(stay)
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await page.reload()
  await page.getByRole('button', { name: `查看${detail.admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, '手术')
  for (const width of [1101, 826]) {
    await size(width)
    await shoot('06-postoperative-summary', width)
    if (before) {
      const entry = page.locator('summary').filter({ hasText: /^术后耗材更正与历史/ })
      await entry.click()
      await shoot('07-material-correction', width)
      await entry.click()
    } else {
      await modal(page.getByRole('button', { name: '补登记与更正耗材', exact: true }).first(), '07-material-correction', width)
      await modal(page.getByRole('button', { name: '本次住院 AI 用量', exact: true }), '08-ai-usage', width)
    }
  }
  if (!before) await matrix(async (width, variant) => {
    const zh = locale === 'zh-CN'
    await stage('investigations')
    await checkWorkspace(`02-acknowledged-${width}-${variant}`)
    await shoot('02-acknowledged', width, variant)
    await modal(page.getByRole('button', { name: zh ? '查看全文' : 'View full report', exact: true }).first(), '03-full-report', width, variant)
    await stage('orders')
    await checkWorkspace(`04-executions-${width}-${variant}`)
    await modal(page.getByRole('button', { name: zh ? /^执行记录/ : /^Execution records/ }).first(), '04-executions', width, variant)
    await stage('surgery')
    await checkWorkspace(`06-postoperative-summary-${width}-${variant}`)
    await shoot('06-postoperative-summary', width, variant)
    await modal(page.getByRole('button', { name: zh ? '申请手术' : 'Request surgery', exact: true }).first(), '05-new-surgery', width, variant)
    await modal(page.getByRole('button', { name: zh ? '补登记与更正耗材' : 'Add or correct materials', exact: true }).first(), '07-material-correction', width, variant)
    const usage = page.getByRole('button', { name: zh ? '本次住院 AI 用量' : 'AI usage for this admission', exact: true })
    await modal(usage, '08-ai-usage', width, variant)
  })
  expect(app.modelCalls).toBe(0)
  expect(errors).toEqual([])
  await writeFile(join(directory, 'layout-checks.json'), `${JSON.stringify(layoutChecks, null, 2)}\n`)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), phase: before ? 'before' : 'after',
    host: 'standalone Web production build, real HTTP listener and temporary SQLite',
    preparation: 'Public Command fixtures create a synthetic PCI stay, four laboratory reports, three administered medication orders and completed surgery. Reading and modal interactions use production UI.',
    widths: [1101, 826], themes: before ? ['light'] : ['light', 'dark'], locales: before ? ['zh-CN'] : ['zh-CN', 'en-US'], modelCalls: app.modelCalls,
  }, null, 2)}\n`)
})

test('术后耗材更正弹窗在矮窗口内独立滚动并保持底部操作可达', async ({ page, pciApp: app }) => {
  test.skip(before, '修改前没有耗材更正弹窗')
  test.setTimeout(90_000)
  const directory = join(output!, 'scroll')
  await mkdir(directory, { recursive: true })
  const stay = await app.fixture.preparePciAdmission()
  await app.fixture.executePci(stay)
  const detail = await app.fixture.read('inpatient-doctor', stay.path, inpatientDetailSchema)
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await page.setViewportSize({ width: 1280, height: 520 })
  await page.goto(`${app.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${detail.admission.patientName}`, exact: true }).click()
  const workspace = page.locator('.clinmesh-card-workspace')
  await workspace.evaluate(element => { element.style.width = '826px' })
  await selectInpatientStage(page, '手术')
  await page.getByRole('button', { name: '补登记与更正耗材', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '术后耗材补登记、更正与历史', exact: true })
  const body = dialog.locator(':scope > .overflow-y-auto')
  const footer = dialog.locator('[data-slot="dialog-footer"]')
  await expect(dialog).toBeVisible()
  const positions = async () => ({
    header: await dialog.locator('[data-slot="dialog-header"]').boundingBox(),
    footer: await footer.boundingBox(),
    page: await page.evaluate(() => ({ top: document.scrollingElement?.scrollTop, left: document.scrollingElement?.scrollLeft })),
  })
  await page.screenshot({ path: join(directory, '09-material-correction-826-scroll-top.png'), animations: 'disabled' })
  const initial = await positions()
  const overflow = await body.evaluate(element => element.scrollHeight - element.clientHeight)
  expect(overflow).toBeGreaterThan(1)
  await body.evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(await body.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
  expect(await positions()).toEqual(initial)
  const history = body.locator('summary').filter({ hasText: /^登记与更正记录/ })
  await expect(history).toBeInViewport()
  await history.click()
  await body.evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const result = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const scroller = element.querySelector('.overflow-y-auto')!
    return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight, horizontalOverflow: element.scrollWidth - element.clientWidth,
      scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }
  })
  expect(result.top).toBeGreaterThanOrEqual(0)
  expect(result.bottom).toBeLessThanOrEqual(result.viewportHeight)
  expect(result.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(result.scrollHeight - result.clientHeight - result.scrollTop).toBeLessThanOrEqual(1)
  await page.screenshot({ path: join(directory, '10-material-correction-826-scroll-bottom.png'), animations: 'disabled' })
  await footer.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(app.modelCalls).toBe(0)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), viewport: { width: 1280, height: 520 }, workspaceWidth: 826, initialOverflow: overflow, final: result, fixedHeaderAndFooter: true, documentScrollUnchanged: true, closeClicked: true, modelCalls: app.modelCalls }, null, 2)}\n`)
})
