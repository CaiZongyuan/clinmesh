import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import type { Page } from '@playwright/test'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { expect, test } from '../../../web/e2e/fixtures.ts'
import { startInvestigationBillingServer } from '../../../web/e2e/investigation-billing.fixture.ts'
import { addInpatientImageReport, openInpatientReportReaderWorkspace, prepareInpatientReportReader, runInpatientReportReaderJourney } from '../../../web/e2e/inpatient-report-reader.journey.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
async function buildReaderSurface(version: string) {
  const styles = await buildSurfaceStyles(), react = version === '18' ? 'react18' : 'react', reactDom = version === '18' ? 'react-dom18' : 'react-dom'
  const generatedStyles = '\0clinmesh-inpatient-report-reader-styles'
  const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [{ name: 'inpatient-report-reader-styles', resolveId(source) { if (source === './styles.generated.ts') return generatedStyles },
      load(id) { if (id === generatedStyles) return `export const clinMeshStyles = ${JSON.stringify(styles)}` } }],
    resolve: { alias: [
      { find: '@clinmesh/web/application', replacement: fileURLToPath(new URL('../../../web/src/app/web-app.tsx', import.meta.url)) },
      { find: '@clinmesh/web/runtime', replacement: fileURLToPath(new URL('../../../web/src/app/web-runtime.tsx', import.meta.url)) },
      { find: /^react$/, replacement: require.resolve(react) }, { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
      { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) }, { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: fileURLToPath(new URL('./dsh-ui-primitives.test-stub.tsx', import.meta.url)) },
      { find: 'dsh-react-surface/client', replacement: fileURLToPath(new URL('../../../../vendor/dsh-react-surface/packages/runtime/src/client/index.tsx', import.meta.url)) },
    ] },
    build: { write: false, lib: { entry: fileURLToPath(new URL('./investigation-billing.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InpatientReportReaderSurface' } },
  })
  const script = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('Missing the real inpatient report reader Surface')
  return script.code
}

async function openSurface(page: Page, origin: string, script: string) {
  await page.route('**/inpatient-report-reader-surface?**', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` }))
  await page.route('**/clinmesh-api/**', route => {
    const url = new URL(route.request().url())
    return route.continue({ url: `${origin}${url.pathname.replace('/clinmesh-api', '/api')}${url.search}` })
  })
  await page.goto(`${origin}/inpatient-report-reader-surface?view=%2Finpatient`)
  await expect(page.locator('.clinmesh-web-root')).toBeVisible()
}

async function verifyReviewAppearance(page: Page) {
  const dialog = page.getByRole('dialog', { name: '住院报告已阅核对', exact: true }), root = page.locator('.clinmesh-web-root')
  expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
  for (const { width, theme, zoom } of [
    { width: 390, theme: 'light', zoom: 1 }, { width: 826, theme: 'dark', zoom: 1 },
    { width: 1101, theme: 'light', zoom: 1 }, { width: 826, theme: 'dark', zoom: 1.25 },
  ]) {
    await page.evaluate(({ width, zoom }) => {
      const host = document.body.querySelector('div')!
      host.style.width = `${width}px`; host.style.zoom = String(zoom)
    }, { width, zoom })
    await root.evaluate((element, theme) => { element.classList.toggle('dark', theme === 'dark'); element.setAttribute('data-theme', theme) }, theme)
    if (zoom > 1) {
      const text = dialog.getByRole('article').first().locator('strong'), before = await text.evaluate(element => parseFloat(getComputedStyle(element).fontSize))
      await root.evaluate(element => element.setAttribute('data-font-size', 'large'))
      await expect.poll(() => text.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(before)
    }
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)) })
    const close = dialog.getByRole('button', { name: '关闭阅读窗口', exact: true }), scroller = dialog.locator('.overflow-y-auto').first()
    await expect(dialog.getByRole('article')).toHaveCount(3)
    await expect(close).toBeInViewport()
    const before = await close.boundingBox()
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(dialog.getByRole('button', { name: '确认选中报告已阅', exact: true })).toBeInViewport()
    expect((await close.boundingBox())!.y).toBeCloseTo(before!.y, 1)
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const hostRight = await page.evaluate(() => document.body.querySelector('div')!.getBoundingClientRect().right), bounds = (await dialog.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(hostRight + 1)
  }
  await page.evaluate(() => { const host = document.body.querySelector('div')!; host.style.width = '1600px'; host.style.zoom = '1' })
}

for (const version of ['18', '19']) test.describe(`住院报告连续阅读 React ${version}`, () => {
  let script: string
  test.beforeAll(async () => { test.setTimeout(120_000); script = await buildReaderSurface(version) })
  test('真实ShadowRoot逐份阅读、关闭撤销阅读资格、原住院回执恢复与独立确认可用', async ({ page, webRoot }) => {
    test.setTimeout(120_000)
    const app = await startInvestigationBillingServer(webRoot, true, { includeCbc: true })
    const errors: string[] = [], pixels: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/\/blocks\/|\/tiles\//, async route => { pixels.push(new URL(route.request().url()).pathname); await route.abort('blockedbyclient') })
    try {
      const subject = await prepareInpatientReportReader(page, app)
      await openInpatientReportReaderWorkspace(page, subject, async () => { await openSurface(page, app.origin, script) })
      await runInpatientReportReaderJourney(page, subject, async caption => { if (caption.startsWith('核对三份')) await verifyReviewAppearance(page) })
      expect(errors).toEqual([])
      expect(pixels).toEqual([])
    } finally { await app.close() }
  })

  test('同次住院检验与真实影像连续阅读，首帧前禁选、切换保留且重开撤销资格', async ({ page, webRoot }) => {
    test.setTimeout(120_000)
    const app = await startInvestigationBillingServer(webRoot, true, { includeCbc: true })
    const errors: string[] = [], writes: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/investigations/acknowledge')) writes.push(request.url()) })
    let release = () => {}, resources = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    try {
      const subject = await prepareInpatientReportReader(page, app), image = await addInpatientImageReport(page, subject)
      await openInpatientReportReaderWorkspace(page, subject, async () => { await openSurface(page, app.origin, script) })
      // 像素只在真实浏览器解码/渲染；测试只读请求聚合、文字和选择资格，禁止截图。
      await page.route(/\/imaging-studies\/[^/]+\/series\/.*\/(?:blocks|tiles)\//, async route => {
        resources++
        await gate
        const response = await route.fetch({ url: route.request().url().replace('/clinmesh-api/', '/api/') })
        await route.fulfill({ response })
      })
      const reader = page.getByRole('dialog', { name: '住院报告阅读与已阅确认', exact: true })
      const trigger = page.getByRole('button', { name: '连续阅读住院报告', exact: true })
      await trigger.click()
      await expect(reader.getByRole('checkbox', { name: /^选择已阅：/ })).toHaveCount(4)
      const choice = reader.getByRole('checkbox', { name: `选择已阅：${image.name}`, exact: true })
      await reader.getByRole('button', { name: `打开报告：${image.name}`, exact: true }).click()
      await expect.poll(() => resources).toBeGreaterThan(0)
      await expect(reader.getByRole('article', { name: '当前报告全文', exact: true })).toContainText(image.name)
      await expect(choice).toBeDisabled()
      release()
      await expect(choice).toBeEnabled()
      await choice.check()
      await reader.getByRole('button', { name: '打开报告：合成白细胞计数', exact: true }).click()
      await expect(choice).toBeChecked()
      await expect(choice).toBeEnabled()
      await reader.getByRole('button', { name: '关闭阅读窗口', exact: true }).click()
      await expect(trigger).toBeFocused()
      await trigger.click()
      await expect(choice).toBeChecked()
      await expect(choice).toBeDisabled()
      expect(writes).toEqual([])
      expect(errors).toEqual([])
      const after = inpatientInvestigationsSchema.parse(await (await page.request.get(app.origin + subject.path + '/investigations')).json())
      expect(after).toEqual(image.facts)
    } finally { release(); await app.close() }
  })
})
