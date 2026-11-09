import { expect, test as base } from '../../../web/e2e/fixtures.ts'
import { createInvestigationSendBatchApp, prepareInvestigationSendBatchPatient, runInvestigationSendBatchJourney } from '../../../web/e2e/inpatient-investigation-send-batch.journey.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'

const test = base.extend({ browserApp: async ({ webRoot }, use) => {
  const app = await createInvestigationSendBatchApp(webRoot, { longNames: true })
  try { await use(app) } finally { await app.close() }
} })

for (const version of ['18', '19']) test.describe(`React ${version} Surface 同患者集中送检`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => { test.setTimeout(60_000); artifact = await buildInpatientDrgFixture(version) })
  test('长中文标本核对在窄屏明暗、缩放和键盘下可达，原回执恢复不连发余项', async ({ page, browserApp }, testInfo) => {
    test.setTimeout(90_000)
    const errors: string[] = [], pixelRequests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/\/(?:pixels|tiles|dicom)(?:\/|\?)/, async route => { pixelRequests.push(new URL(route.request().url()).pathname); await route.abort() })
    const s = await prepareInvestigationSendBatchPatient(page, browserApp)
    const url = `${browserApp.origin}/investigation-send-batch-contract`
    await page.route(url, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await page.setViewportSize({ width: 390, height: 844 })
    let reviewed = false
    const evidence = await runInvestigationSendBatchJourney(page, s, async () => { await page.goto(url) }, async caption => {
      if (caption.startsWith('病区护士选择')) {
        await page.screenshot({ path: testInfo.outputPath('send-drafts-390.png'), animations: 'disabled' })
      }
      const dialog = page.getByRole('dialog', { name: '集中送检核对', exact: true })
      if (await dialog.isVisible() && !reviewed) {
        reviewed = true
        expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        const root = page.locator('.clinmesh-web-root')
        await expect(root).toHaveAttribute('data-font-size', 'large')
        const bounds = await dialog.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
        expect(bounds!.y).toBeGreaterThanOrEqual(0)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)
        const confirm = dialog.getByRole('button', { name: '确认送检', exact: true })
        await confirm.click({ trial: true })
        const body = dialog.locator('.overflow-y-auto')
        expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
        const before = await dialog.getByRole('heading', { name: '集中送检核对', exact: true }).boundingBox()
        await body.evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect(dialog.getByRole('article').last()).toBeInViewport()
        expect((await dialog.getByRole('heading', { name: '集中送检核对', exact: true }).boundingBox())!.y).toBe(before!.y)
        await expect(confirm).toBeInViewport()
        for (const width of [390, 1101, 826]) for (const theme of ['light', 'dark']) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
          await root.evaluate((element, value) => { element.classList.toggle('dark', value === 'dark'); element.setAttribute('data-theme', value) }, theme)
          await confirm.click({ trial: true })
          await body.evaluate(element => { element.scrollTop = element.scrollHeight })
          await expect(dialog.getByRole('article').last()).toBeInViewport()
          await expect(confirm).toBeInViewport()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: testInfo.outputPath(`send-review-${width}-${theme}.png`), animations: 'disabled' })
        }
        await page.setViewportSize({ width: 390, height: 844 })
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        const trigger = page.getByRole('button', { name: '集中送检', exact: true })
        await expect(trigger).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(dialog).toBeVisible()
        await page.setViewportSize({ width: 480, height: 900 })
        await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
        await confirm.click({ trial: true })
        await expect(confirm).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath('send-review-125-dark.png'), animations: 'disabled' })
        await page.evaluate(() => { document.documentElement.style.zoom = '' })
        await page.setViewportSize({ width: 390, height: 844 })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
    expect(reviewed).toBe(true)
    expect(evidence).toMatchObject({ posts: 3, sent: 3, reports: 0, charges: 0 })
    expect(errors).toEqual([])
    expect(pixelRequests).toEqual([])
  })
})
