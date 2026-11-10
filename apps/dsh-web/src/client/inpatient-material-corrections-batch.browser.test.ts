import { expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { prepareMaterialCorrectionsBatchPatient, runMaterialCorrectionsBatchJourney } from '../../../web/e2e/inpatient-material-corrections-batch.journey.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`React ${version} Surface 术后连续更正`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => { test.setTimeout(60_000); artifact = await buildInpatientDrgFixture(version) })
  test('390宽与125%缩放下保留逐笔输入、键盘焦点与原回执恢复', async ({ page, browserApp }, testInfo) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const s = await prepareMaterialCorrectionsBatchPatient(page, browserApp)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route(`${browserApp.origin}/material-corrections-batch-contract`, route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`,
    }))
    let zoomChecked = false
    const result = await runMaterialCorrectionsBatchJourney(page, s,
      async () => { await page.goto(`${browserApp.origin}/material-corrections-batch-contract`) },
      async () => {
        const dialog = page.getByRole('dialog', { name: '术后耗材补登记、更正与历史', exact: true })
        expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        const bounds = await dialog.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (!zoomChecked) {
          zoomChecked = true
          await page.screenshot({ path: testInfo.outputPath('correction-inputs-390.png') })
          await page.setViewportSize({ width: 480, height: 900 })
          await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
          const reason = dialog.getByLabel('共同更正依据', { exact: true })
          await reason.scrollIntoViewIfNeeded()
          await reason.click()
          await expect(reason).toBeFocused()
          const review = dialog.getByRole('button', { name: '集中核对更正', exact: true })
          await review.scrollIntoViewIfNeeded()
          await expect(review).toBeInViewport()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: testInfo.outputPath('correction-inputs-125.png') })
          await page.evaluate(() => { document.documentElement.style.zoom = '' })
          await page.setViewportSize({ width: 390, height: 844 })
        }
        const confirmation = dialog.getByRole('region', { name: '更正核对清单', exact: true })
        if (await confirmation.isVisible()) {
          await confirmation.getByRole('button', { name: '确认更正', exact: true }).scrollIntoViewIfNeeded()
          await page.screenshot({ path: testInfo.outputPath('correction-review-390.png') })
          await page.setViewportSize({ width: 480, height: 900 })
          await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
          await confirmation.getByRole('button', { name: '确认更正', exact: true }).scrollIntoViewIfNeeded()
          await page.screenshot({ path: testInfo.outputPath('correction-review-125.png') })
          await page.evaluate(() => { document.documentElement.style.zoom = '' })
          await page.setViewportSize({ width: 390, height: 844 })
        }
      })
    expect(zoomChecked).toBe(true)
    expect(result).toMatchObject({ posts: 2, audits: 2, chargesFen: 200000, historyCount: 3 })
    expect(errors).toEqual([])
  })
})
