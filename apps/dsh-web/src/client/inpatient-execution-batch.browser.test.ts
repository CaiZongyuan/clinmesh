import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, test } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { openInpatientExecutionWorkspace, prepareInpatientExecutionBatch, runInpatientExecutionBatchJourney,
  runInpatientExecutionRecoveryJourney, runInpatientExecutionSelectionJourney } from '../../../web/e2e/inpatient-execution-batch.journey.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, Promise<string>>()
function buildExecutionSurface(version: string) {
  const existing = artifacts.get(version)
  if (existing) return existing
  const pending = (async () => {
    const styles = await buildSurfaceStyles(), react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const generatedStyles = '\0clinmesh-execution-batch-styles'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      plugins: [{ name: 'execution-batch-styles', resolveId(source) { if (source === './styles.generated.ts') return generatedStyles },
        load(id) { if (id === generatedStyles) return `export const clinMeshStyles = ${JSON.stringify(styles)}` } }],
      resolve: { alias: [
        { find: '@clinmesh/web/application', replacement: fileURLToPath(new URL('../../../web/src/app/web-app.tsx', import.meta.url)) },
        { find: '@clinmesh/web/runtime', replacement: fileURLToPath(new URL('../../../web/src/app/web-runtime.tsx', import.meta.url)) },
        { find: /^react$/, replacement: require.resolve(react) }, { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) }, { find: /^react-dom$/, replacement: require.resolve(reactDom) },
        { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: fileURLToPath(new URL('./dsh-ui-primitives.test-stub.tsx', import.meta.url)) },
        { find: 'dsh-react-surface/client', replacement: fileURLToPath(new URL('../../../../vendor/dsh-react-surface/packages/runtime/src/client/index.tsx', import.meta.url)) },
      ] },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./investigation-billing.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InpatientExecutionSurface' } },
    })
    const script = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing the real inpatient execution Surface')
    return script.code
  })()
  artifacts.set(version, pending)
  return pending
}

async function openSurface(page: Page, origin: string, script: string) {
  await page.route('**/inpatient-execution-surface?**', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }))
  await page.route('**/clinmesh-api/**', route => {
    const url = new URL(route.request().url())
    return route.continue({ url: `${origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
  })
  await page.goto(`${origin}/inpatient-execution-surface?view=%2Finpatient`)
  await expect(page.locator('.clinmesh-web-root')).toBeVisible()
}

async function reviewAppearanceMatrix(page: Page, dialog: Locator, trigger: Locator, info: TestInfo, prefix: string) {
  expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
  const root = page.locator('.clinmesh-web-root')
  await root.evaluate(element => element.setAttribute('data-font-size', 'normal'))
  for (const { width, theme, zoom } of [
    { width: 390, theme: 'light', zoom: 1 }, { width: 826, theme: 'dark', zoom: 1 },
    { width: 1101, theme: 'light', zoom: 1 }, { width: 826, theme: 'dark', zoom: 1.25 },
  ]) {
    await page.evaluate(({ width, zoom }) => {
      const host = document.body.querySelector('div')!
      // 固定宿主的真实可用尺寸，缩放只减少其有效CSS空间。
      host.style.width = `${width / zoom}px`; host.style.height = `${innerHeight / zoom}px`; host.style.zoom = String(zoom)
    }, { width, zoom })
    await root.evaluate((element, theme) => { element.classList.toggle('dark', theme === 'dark'); element.setAttribute('data-theme', theme) }, theme)
    if (zoom > 1) {
      const text = dialog.getByRole('article').first().locator('h3')
      const font = await text.evaluate(element => parseFloat(getComputedStyle(element).fontSize))
      const scale = await root.evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue('--clinmesh-font-scale')))
      await root.evaluate(element => element.setAttribute('data-font-size', 'large'))
      const large = await root.evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue('--clinmesh-font-scale')))
      expect(large).toBeGreaterThan(scale)
      await expect.poll(() => text.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(font * large / scale, 3)
    }
    const heading = dialog.getByRole('heading').first(), confirm = dialog.getByRole('button', { name: /^确认/ })
    const close = dialog.getByRole('button', { name: '关闭办理窗口', exact: true })
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)) })
    await expect(dialog.getByRole('article')).toHaveCount(2)
    await expect(heading).toBeVisible(); await expect(confirm).toBeEnabled(); await expect(close).toBeEnabled()
    const scroller = dialog.locator('.overflow-y-auto').first()
    const before = await heading.boundingBox(), footer = await confirm.boundingBox()
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const last = await dialog.getByRole('article').last().boundingBox(), bounds = await scroller.boundingBox()
    expect(last!.y).toBeGreaterThanOrEqual(bounds!.y - 1)
    expect(last!.y + last!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1)
    expect((await heading.boundingBox())!.y).toBeCloseTo(before!.y, 1)
    expect((await confirm.boundingBox())!.y).toBeCloseTo(footer!.y, 1)
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const evidence = {
      viewport: page.viewportSize(), dialog: await dialog.boundingBox(), heading: await heading.boundingBox(), confirm: await confirm.boundingBox(),
      close: await close.boundingBox(), scroller: bounds, last,
      ancestors: await confirm.evaluate(element => {
        const results = []
        for (let current: Element | null = element; current; ) {
          const style = getComputedStyle(current), rect = current.getBoundingClientRect()
          results.push({ tag: current.tagName, class: current.className, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, overflow: style.overflow, zoom: style.zoom })
          const parent = current.parentElement, tree = current.getRootNode()
          current = parent ?? (tree instanceof ShadowRoot ? tree.host : null)
        }
        return results
      }),
    }
    const evidencePath = info.outputPath(`${prefix}-${width}-${theme}-${zoom}-bounds.json`)
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
    await info.attach(`${prefix}-${width}-${theme}-${zoom}-bounds`, { contentType: 'application/json', path: evidencePath })
    await expect(confirm, JSON.stringify(evidence)).toBeInViewport(); await expect(close).toBeInViewport()
    const hostRight = await page.evaluate(() => document.body.querySelector('div')!.getBoundingClientRect().right)
    const box = await dialog.boundingBox()
    expect(hostRight).toBeCloseTo(width, 1)
    expect(await root.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(page.viewportSize()!.height, 1)
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(hostRight + 1)
    if (width === 390 || zoom > 1) await dialog.screenshot({ path: info.outputPath(`${prefix}-${width}-${theme}-${zoom}.png`) })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    // 回到核对态：关闭窗口只保存人工草稿，不直接提交。
    await dialog.getByRole('button', { name: /^核对.+ \(2\)$/ }).click()
  }
  await page.evaluate(() => { const host = document.body.querySelector('div')!; host.style.width = '1600px'; host.style.height = '100vh'; host.style.zoom = '1' })
  await root.evaluate(element => element.setAttribute('data-font-size', 'normal'))
}

for (const version of ['18', '19']) test.describe(`护士实际执行集中办理 React ${version}`, () => {
  let script: string
  test.beforeAll(async () => { test.setTimeout(120_000); script = await buildExecutionSurface(version) })
  test('真实上游 ShadowRoot 分别保存给药教育与 PRN，长理由、窄屏和大字号仍可核对', async ({ page, pciApp }, info) => {
    test.setTimeout(180_000)
    const errors: string[] = [], pixels: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/\/blocks\/|\/tiles\//, async route => { pixels.push(new URL(route.request().url()).pathname); await route.abort('blockedbyclient') })
    const subject = await prepareInpatientExecutionBatch(page, pciApp)
    await openInpatientExecutionWorkspace(page, subject, () => openSurface(page, pciApp.origin, script))
    const actions = [
      { caption: '集中核对两项', title: '集中记录给药', prefix: 'administer' },
      { caption: '健康教育独立', title: '集中记录健康教育', prefix: 'education' },
      { caption: 'PRN 单独', title: '集中发起 PRN', prefix: 'prn' },
    ]
    await runInpatientExecutionBatchJourney(page, subject, async caption => {
      const action = actions.find(item => caption.startsWith(item.caption))
      if (action) await reviewAppearanceMatrix(page, page.getByRole('dialog', { name: action.title, exact: true }),
        page.getByRole('button', { name: action.title, exact: true }), info, `${action.prefix}-react${version}`)
    }, ['本次介入治疗需逐项核对实际适应情况，尚未给药。'.repeat(12), '单项造影理由：核对造影需求与原医嘱，尚未给药。'.repeat(14)])
    expect(errors).toEqual([]); expect(pixels).toEqual([])
  })

  test('第二项已提交后丢响应，刷新在原动作窗口恢复回执且余项重新人工确认', async ({ page, pciApp }) => {
    test.setTimeout(120_000)
    const subject = await prepareInpatientExecutionBatch(page, pciApp, { educationCount: 3 })
    const open = () => openSurface(page, pciApp.origin, script)
    await openInpatientExecutionWorkspace(page, subject, open)
    await runInpatientExecutionRecoveryJourney(page, subject, open)
  })

  test('真实刷新恢复核实与选择，搜索保留清单，明确丢弃与退出登录清除草稿', async ({ page, pciApp }) => {
    test.setTimeout(120_000)
    const subject = await prepareInpatientExecutionBatch(page, pciApp)
    const open = () => openSurface(page, pciApp.origin, script)
    await openInpatientExecutionWorkspace(page, subject, open)
    await runInpatientExecutionSelectionJourney(page, subject, open)
  })
})
