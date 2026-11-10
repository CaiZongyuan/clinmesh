import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { startDoctorFirstVisit, startInvestigationBillingServer } from '../../../web/e2e/investigation-billing.fixture.ts'
import { expectFourUnpaidCharges, prepareMultiChargeInvestigations, rejectClinicalMedia } from '../../../web/e2e/multi-charge-payment.fixture.ts'
import { clearMultiChargeDraftJourney, logoutMultiChargeDraftJourney, multiChargeDialog, previewSelectedCharges, recoverMultiChargePreviewJourney, runMultiChargePreviewJourney } from '../../../web/e2e/multi-charge-payment.journey.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'
import { runMultiChargeBalanceJourney } from '../../../web/e2e/multi-charge-balance.journey.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, Promise<string>>()
function buildMultiChargeSurface(version: string) {
  const existing = artifacts.get(version)
  if (existing) return existing
  const pending = (async () => {
    const styles = await buildSurfaceStyles()
    const react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const generatedStyles = '\0clinmesh-multi-charge-styles'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      plugins: [{ name: 'multi-charge-styles', resolveId(source) { if (source === './styles.generated.ts') return generatedStyles },
        load(id) { if (id === generatedStyles) return `export const clinMeshStyles = ${JSON.stringify(styles)}` } }],
      resolve: { alias: [
        { find: '@clinmesh/web/application', replacement: fileURLToPath(new URL('../../../web/src/app/web-app.tsx', import.meta.url)) },
        { find: '@clinmesh/web/runtime', replacement: fileURLToPath(new URL('../../../web/src/app/web-runtime.tsx', import.meta.url)) },
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
        { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: fileURLToPath(new URL('./dsh-ui-primitives.test-stub.tsx', import.meta.url)) },
        { find: 'dsh-react-surface/client', replacement: fileURLToPath(new URL('../../../../vendor/dsh-react-surface/packages/runtime/src/client/index.tsx', import.meta.url)) },
      ] },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./investigation-billing.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'MultiChargeSurface' } },
    })
    const script = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing the real cashier Surface')
    return script.code
  })()
  artifacts.set(version, pending)
  return pending
}

async function openSurface(page: Page, origin: string, script: string, view: string) {
  await page.route('**/multi-charge-surface?**', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }))
  await page.route('**/clinmesh-api/**', route => {
    const url = new URL(route.request().url())
    return route.continue({ url: `${origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
  })
  await page.goto(`${origin}/multi-charge-surface?view=${encodeURIComponent(view)}`)
}

const longLaboratoryName = '合成白细胞计数（门诊感染风险评估、当前费用余额及原项目来源逐项核对用合成长中文名称）'
async function reviewMultiChargeAppearance(page: Page, dialog: Locator, info: TestInfo, version: string) {
  const root = page.locator('.clinmesh-web-root')
  const trigger = page.getByRole('button', { name: '选择多项收费', exact: true })
  if (!(await dialog.isVisible())) await trigger.click()
  await dialog.getByRole('button', { name: '全选本页可收费项目', exact: true }).click()
  await previewSelectedCharges(page, dialog)
  await root.evaluate(element => element.setAttribute('data-font-size', 'normal'))
  for (const { width, theme, zoom } of [
    ...[390, 826, 1101].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme, zoom: 1 }))),
    { width: 826, theme: 'dark', zoom: 1.25 },
  ]) {
    await page.evaluate(({ width, zoom }) => {
      const host = document.body.querySelector('div')!
      host.style.width = `${width / zoom}px`; host.style.height = `${innerHeight / zoom}px`; host.style.zoom = String(zoom)
    }, { width, zoom })
    await root.evaluate((element, theme) => { element.classList.toggle('dark', theme === 'dark'); element.setAttribute('data-theme', theme) }, theme)
    const heading = dialog.getByRole('heading', { name: '选择多项收费', exact: true })
    if (zoom > 1) {
      const normal = await heading.evaluate(element => parseFloat(getComputedStyle(element).fontSize))
      const scale = await root.evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue('--clinmesh-font-scale')))
      await root.evaluate(element => element.setAttribute('data-font-size', 'large'))
      const large = await root.evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue('--clinmesh-font-scale')))
      expect(large).toBeGreaterThan(scale)
      await expect.poll(() => heading.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(normal * large / scale, 3)
    }
    await dialog.evaluate(async element => { await Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)) })
    const scroller = dialog.locator('.overflow-y-auto').first()
    const preview = dialog.getByRole('region', { name: '合并收费预览', exact: true })
    const confirm = dialog.getByRole('button', { name: '预览合并收费', exact: true })
    const close = dialog.getByRole('button', { name: 'Close', exact: true })
    const headingBefore = await heading.boundingBox(), footerBefore = await confirm.boundingBox()
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const last = preview.getByRole('row').last()
    const bounds = await scroller.boundingBox(), lastBounds = await last.boundingBox()
    const tables = []
    for (const name of ['完整费用清单', '合并收费预览']) {
      const region = dialog.getByRole('region', { name, exact: true })
      const container = region.locator('[data-slot="table-container"]')
      await container.evaluate(element => { element.scrollLeft = 0 })
      const firstCell = region.getByRole('row').filter({ hasText: longLaboratoryName }).getByRole('cell').first()
      const geometry = await firstCell.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element)
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), lines = []
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue
          const text = document.createRange(); text.selectNodeContents(walker.currentNode)
          lines.push(...Array.from(text.getClientRects(), rect => rect.toJSON()))
        }
        return { cell: element.getBoundingClientRect().toJSON(), text: range.getBoundingClientRect().toJSON(), lines,
          whiteSpace: getComputedStyle(element).whiteSpace, cellClass: element.className, tableClass: element.closest('table')!.className }
      })
      const scroll = await container.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
      await container.evaluate(element => { element.scrollLeft = element.scrollWidth })
      const lastCell = region.getByRole('row').last().getByRole('cell').last()
      const viewport = await container.boundingBox(), value = await lastCell.boundingBox()
      tables.push({ name, ...geometry, ...scroll, viewport, lastCell: value })
    }
    const evidence = { version, width, theme, zoom, viewport: page.viewportSize(), host: await page.evaluate(() => document.body.querySelector('div')!.getBoundingClientRect().toJSON()),
      dialog: await dialog.boundingBox(), heading: await heading.boundingBox(), footer: await confirm.boundingBox(), scroller: bounds, last: lastBounds, tables }
    const filename = `multi-charge-react${version}-${width}-${theme}-${zoom}`
    await writeFile(info.outputPath(`${filename}.json`), JSON.stringify(evidence, null, 2) + '\n')
    await info.attach(filename, { contentType: 'application/json', path: info.outputPath(`${filename}.json`) })
    await dialog.screenshot({ path: info.outputPath(`${filename}-amounts.png`), animations: 'disabled' })
    await dialog.locator('[data-slot="table-container"]').evaluateAll(elements => { for (const element of elements) element.scrollLeft = 0 })
    await dialog.screenshot({ path: info.outputPath(`${filename}-names.png`), animations: 'disabled' })
    expect(evidence.host.width).toBeCloseTo(width, 1)
    expect(await root.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(page.viewportSize()!.height, 1)
    expect(evidence.dialog!.x).toBeGreaterThanOrEqual(0)
    expect(evidence.dialog!.x + evidence.dialog!.width).toBeLessThanOrEqual(width + 1)
    await expect(confirm).toBeInViewport(); await expect(close).toBeInViewport(); await expect(confirm).toBeEnabled()
    expect((await heading.boundingBox())!.y).toBeCloseTo(headingBefore!.y, 1)
    expect((await confirm.boundingBox())!.y).toBeCloseTo(footerBefore!.y, 1)
    expect(lastBounds!.y).toBeGreaterThanOrEqual(bounds!.y - 1)
    expect(lastBounds!.y + lastBounds!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1)
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    for (const table of tables) {
      expect(table.cell.width, `${table.name}: long name must wrap within a readable column`).toBeLessThanOrEqual(384)
      expect(table.whiteSpace, `${table.name}: long name must use real wrapping`).toBe('normal')
      expect(table.lines.length, `${table.name}: long name must span multiple text lines`).toBeGreaterThan(1)
      for (const line of table.lines) {
        expect(line.x, `${table.name}: text must remain inside its own column`).toBeGreaterThanOrEqual(table.cell.x - 1)
        expect(line.right, `${table.name}: text must not overlap amount columns`).toBeLessThanOrEqual(table.cell.right + 1)
      }
      expect(table.lastCell!.x).toBeGreaterThanOrEqual(table.viewport!.x - 1)
      expect(table.lastCell!.x + table.lastCell!.width).toBeLessThanOrEqual(table.viewport!.x + table.viewport!.width + 1)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('region', { name: '合并收费预览', exact: true })).toHaveCount(0)
    await previewSelectedCharges(page, dialog)
  }
  await page.evaluate(() => { const host = document.body.querySelector('div')!; host.style.width = '1600px'; host.style.height = `${innerHeight}px`; host.style.zoom = '1' })
  await root.evaluate(element => element.setAttribute('data-font-size', 'normal'))
}

for (const version of ['18', '19']) test.describe(`真实上游多费用预览 React ${version}`, () => {
  let script: string
  test.beforeAll(async () => { test.setTimeout(120_000); script = await buildMultiChargeSurface(version) })
  test('真实费用预览、原回执与私稿恢复，医保及原单项分次款变化撤销旧冻结', async ({ page, browser, webRoot }, info) => {
    test.setTimeout(180_000)
    const server = await startInvestigationBillingServer(webRoot, true, { '0100101A': longLaboratoryName })
    const cashierContext = await browser.newContext()
    const cashier = await cashierContext.newPage()
    const otherContext = await browser.newContext(), other = await otherContext.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    cashier.on('pageerror', error => errors.push(error.message))
    other.on('pageerror', error => errors.push(error.message))
    const doctorMedia = await rejectClinicalMedia(page), cashierMedia = await rejectClinicalMedia(cashier), otherMedia = await rejectClinicalMedia(other)
    try {
      await page.setViewportSize({ width: 1600, height: 900 })
      await cashier.setViewportSize({ width: 1600, height: 900 })
      await openSurface(page, server.origin, script, '/consultation')
      await startDoctorFirstVisit(page, server.password)
      const prepared = await prepareMultiChargeInvestigations(page, server, longLaboratoryName)
      await openSurface(cashier, server.origin, script, '/billing')
      await cashier.getByLabel('账户邮箱').fill('cashier@demo.clinmesh.local')
      await cashier.getByLabel('账户密码').fill(server.password)
      await cashier.getByRole('button', { name: '登录', exact: true }).click()
      await expect(cashier.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
      await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
      const bill = cashier.getByRole('region', { name: '本次就诊账单', exact: true })
      await expect(bill).toBeVisible()
      expect(await bill.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      await runMultiChargePreviewJourney(cashier, server, prepared.chargeIds)
      const dialog = multiChargeDialog(cashier)
      expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      await clearMultiChargeDraftJourney(dialog)
      for (const mode of ['after-commit', 'before-send', 'corrupted-draft'] as const) await recoverMultiChargePreviewJourney(cashier, server, mode)
      for (const restricted of [false, true]) await logoutMultiChargeDraftJourney(cashier, server, restricted)
      expect(doctorMedia).toEqual([]); expect(cashierMedia).toEqual([])
      await reviewMultiChargeAppearance(cashier, dialog, info, version)
      await expectFourUnpaidCharges(cashier, server, prepared.chargeIds)
      await cashier.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await openSurface(other, server.origin, script, '/billing')
      await other.getByLabel('账户邮箱').fill('cashier@demo.clinmesh.local')
      await other.getByLabel('账户密码').fill(server.password)
      await other.getByRole('button', { name: '登录', exact: true }).click()
      await expect(other.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
      await runMultiChargeBalanceJourney(cashier, other, page, server, prepared.chargeIds, prepared.requestIds)
      expect(errors).toEqual([])
      expect(doctorMedia).toEqual([])
      expect(cashierMedia).toEqual([])
      expect(otherMedia).toEqual([])
    } finally {
      await page.close()
      await otherContext.close()
      await cashierContext.close()
      await server.close()
    }
  })
})
