import { expect, test } from '../../../web/e2e/fixtures.ts'
import { prepareOrderVerificationBatchPatient, runOrderVerificationBatchJourney } from '../../../web/e2e/inpatient-order-verification-batch.journey.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`React ${version} Surface 新医嘱集中校对`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => { test.setTimeout(60_000); artifact = await buildInpatientDrgFixture(version) })
  test('390宽及125%缩放下逐项核对、私稿恢复与原回执恢复', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const errors: string[] = [], pixelRequests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/\/(?:pixels|tiles|dicom)(?:\/|\?)/, async route => {
      pixelRequests.push(new URL(route.request().url()).pathname)
      await route.abort()
    })
    const s = await prepareOrderVerificationBatchPatient(page, browserApp)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route(`${browserApp.origin}/order-verification-batch-contract`, route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`,
    }))
    let reviewedLayout = false
    await runOrderVerificationBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/order-verification-batch-contract`) }, async () => {
      const dialog = page.getByRole('dialog', { name: '集中核对新医嘱', exact: true })
      if (await dialog.isVisible() && !reviewedLayout) {
        reviewedLayout = true
        expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        const bounds = await dialog.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
        expect(bounds!.y).toBeGreaterThanOrEqual(0)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)
        const confirm = dialog.getByRole('button', { name: '确认校对 3 条新医嘱', exact: true })
        await expect(confirm).toBeInViewport()
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        const trigger = page.getByRole('button', { name: '集中核对新医嘱 (3)', exact: true })
        await expect(trigger).toBeFocused()
        await trigger.click()
        await page.setViewportSize({ width: 480, height: 900 })
        await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
        await expect(confirm).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.evaluate(() => { document.documentElement.style.zoom = '' })
        await page.setViewportSize({ width: 390, height: 844 })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
    expect(reviewedLayout).toBe(true)
    expect(errors).toEqual([])
    expect(pixelRequests).toEqual([])
  })
})
