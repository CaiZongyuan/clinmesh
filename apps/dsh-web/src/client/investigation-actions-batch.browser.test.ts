import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { startInvestigationBillingServer } from '../../../web/e2e/investigation-billing.fixture.ts'
import { openOutpatientInvestigationActions, prepareInpatientInvestigationActions, prepareOutpatientInvestigationCancel,
  runInpatientInvestigationRetryJourney, runInpatientInvestigationSelectionJourney, runOutpatientInvestigationCancelJourney } from '../../../web/e2e/investigation-actions-batch.journey.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, Promise<string>>()

function buildActionsSurface(version: string) {
  const existing = artifacts.get(version)
  if (existing) return existing
  const pending = (async () => {
    const styles = await buildSurfaceStyles(), react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const generatedStyles = '\0clinmesh-investigation-action-styles'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      plugins: [{ name: 'investigation-action-styles', resolveId(source) { if (source === './styles.generated.ts') return generatedStyles },
        load(id) { if (id === generatedStyles) return `export const clinMeshStyles = ${JSON.stringify(styles)}` } }],
      resolve: { alias: [
        { find: '@clinmesh/web/application', replacement: fileURLToPath(new URL('../../../web/src/app/web-app.tsx', import.meta.url)) },
        { find: '@clinmesh/web/runtime', replacement: fileURLToPath(new URL('../../../web/src/app/web-runtime.tsx', import.meta.url)) },
        { find: /^react$/, replacement: require.resolve(react) }, { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) }, { find: /^react-dom$/, replacement: require.resolve(reactDom) },
        { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: fileURLToPath(new URL('./dsh-ui-primitives.test-stub.tsx', import.meta.url)) },
        { find: 'dsh-react-surface/client', replacement: fileURLToPath(new URL('../../../../vendor/dsh-react-surface/packages/runtime/src/client/index.tsx', import.meta.url)) },
      ] },
      build: { write: false, lib: { entry: fileURLToPath(new URL('./investigation-billing.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InvestigationActionsSurface' } },
    })
    const script = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing the real investigation actions Surface')
    return script.code
  })()
  artifacts.set(version, pending)
  return pending
}

async function openSurface(page: Page, origin: string, script: string, view: string) {
  await page.route('**/investigation-actions-surface?**', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }))
  await page.route('**/clinmesh-api/**', route => {
    const url = new URL(route.request().url())
    return route.continue({ url: `${origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
  })
  await page.goto(`${origin}/investigation-actions-surface?view=${encodeURIComponent(view)}`)
  await expect(page.locator('.clinmesh-web-root')).toBeVisible()
}

async function reviewAppearanceMatrix(page: Page, dialog: Locator, trigger: Locator, info: TestInfo, prefix: string, count: number) {
  expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
  const root = page.locator('.clinmesh-web-root')
  for (const { width, theme, zoom } of [
    { width: 390, theme: 'light', zoom: 1 }, { width: 826, theme: 'dark', zoom: 1 },
    { width: 1101, theme: 'light', zoom: 1 }, { width: 826, theme: 'dark', zoom: 1.25 },
  ]) {
    await page.evaluate(({ width, zoom }) => {
      const host = document.body.querySelector('div')!
      host.style.width = `${width}px`
      host.style.zoom = String(zoom)
    }, { width, zoom })
    await root.evaluate((element, theme) => { element.classList.toggle('dark', theme === 'dark'); element.setAttribute('data-theme', theme) }, theme)
    if (zoom > 1) {
      const text = dialog.getByRole('article').first().locator('strong')
      const font = await text.evaluate(element => parseFloat(getComputedStyle(element).fontSize))
      const scale = await root.evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue('--clinmesh-font-scale')))
      await root.evaluate(element => element.setAttribute('data-font-size', 'large'))
      const large = await root.evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue('--clinmesh-font-scale')))
      expect(large).toBeGreaterThan(scale)
      await expect.poll(() => text.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(font * large / scale, 3)
    }
    const heading = dialog.getByRole('heading').first(), confirm = dialog.getByRole('button', { name: /^确认/ })
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)) })
    await expect(dialog.getByRole('article')).toHaveCount(count)
    await expect(heading).toBeVisible()
    await expect(confirm).toBeEnabled()
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
    await expect(confirm).toBeInViewport()
    const bodyWidth = await page.evaluate(() => document.body.querySelector('div')!.getBoundingClientRect().right)
    const box = await dialog.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(bodyWidth + 1)
    if (width === 390 || zoom > 1) await dialog.screenshot({ path: info.outputPath(`${prefix}-${width}-${theme}-${zoom}.png`) })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
  }
  await page.evaluate(() => { const host = document.body.querySelector('div')!; host.style.width = '1600px'; host.style.zoom = '1' })
}

for (const version of ['18', '19']) test.describe(`检查申请集中办理 React ${version}`, () => {
  let script: string
  test.beforeAll(async () => { test.setTimeout(120_000); script = await buildActionsSurface(version) })

  test('门诊三申请原回执恢复在真实ShadowRoot保留独立动作与核对布局', async ({ page, webRoot }, info) => {
    test.setTimeout(120_000)
    const app = await startInvestigationBillingServer(webRoot, false, { includeCbc: true })
    const errors: string[] = [], pixels: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/\/blocks\/|\/tiles\//, async route => { pixels.push(new URL(route.request().url()).pathname); await route.abort('blockedbyclient') })
    try {
      const subject = await prepareOutpatientInvestigationCancel(page, app, 3)
      await openOutpatientInvestigationActions(page, subject, async () => { await openSurface(page, app.origin, script, '/consultation') })
      await runOutpatientInvestigationCancelJourney(page, subject, true, async caption => {
        if (caption.startsWith('集中预览')) await reviewAppearanceMatrix(page, page.getByRole('dialog', { name: '集中取消申请核对', exact: true }),
          page.getByRole('button', { name: '集中取消申请', exact: true }), info, `outpatient-react${version}`, 3)
      })
      expect(errors).toEqual([])
      expect(pixels).toEqual([])
    } finally { await app.close() }
  })

  test('住院两项失败检查在真实ShadowRoot集中重试并保留两项原执行费', async ({ page, webRoot }, info) => {
    test.setTimeout(120_000)
    const app = await startInvestigationBillingServer(webRoot, true, { includeCt: true })
    const errors: string[] = [], pixels: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/\/blocks\/|\/tiles\//, async route => { pixels.push(new URL(route.request().url()).pathname); await route.abort('blockedbyclient') })
    try {
      const subject = await prepareInpatientInvestigationActions(page, app, { retry: true })
      await runInpatientInvestigationRetryJourney(page, subject, async () => { await openSurface(page, app.origin, script, '/inpatient') }, async caption => {
        if (caption.startsWith('核对两项')) await reviewAppearanceMatrix(page, page.getByRole('dialog', { name: '集中重试结果生成', exact: true }),
          page.getByRole('button', { name: '集中重新生成', exact: true }), info, `inpatient-react${version}`, 2)
      })
      expect(errors).toEqual([])
      expect(pixels).toEqual([])
    } finally { await app.close() }
  })

  test('住院待处理选择刷新后恢复，搜索和动作隔离、确认丢弃与真实退出清除可用', async ({ page, webRoot }) => {
    test.setTimeout(120_000)
    const app = await startInvestigationBillingServer(webRoot)
    const writes: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && /\/investigations\/(cancel|retry)$/.test(new URL(request.url()).pathname)) writes.push(request.url()) })
    try {
      const subject = await prepareInpatientInvestigationActions(page, app)
      await runInpatientInvestigationSelectionJourney(page, subject, async () => { await openSurface(page, app.origin, script, '/inpatient') })
      expect(writes).toEqual([])
    } finally { await app.close() }
  })
})
