import { expect, test } from '../../../web/e2e/fixtures.ts'
import { prepareOrderVerificationBatchPatient, runOrderVerificationBatchJourney } from '../../../web/e2e/inpatient-order-verification-batch.journey.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'
import { inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { openQueue } from '../../../web/e2e/queue-overlay.fixture.ts'
import { selectInpatientStage } from '../../../web/e2e/inpatient-ui.ts'

for (const version of ['18', '19']) test.describe(`React ${version} Surface 新医嘱集中校对`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => { test.setTimeout(60_000); artifact = await buildInpatientDrgFixture(version) })
  test('390宽及125%缩放下逐项核对、私稿恢复与原回执恢复', async ({ page, browserApp }, testInfo) => {
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
    await runOrderVerificationBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/order-verification-batch-contract`) }, async caption => {
      if (caption.startsWith('病区护士选择')) {
        await page.screenshot({ path: testInfo.outputPath('verification-drafts-390.png'), animations: 'disabled' })
        await page.setViewportSize({ width: 1101, height: 1000 })
        await page.screenshot({ path: testInfo.outputPath('verification-drafts-1101.png'), animations: 'disabled' })
        await page.setViewportSize({ width: 390, height: 844 })
      }
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
        await page.screenshot({ path: testInfo.outputPath('verification-review-390.png'), animations: 'disabled' })
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        const trigger = page.getByRole('button', { name: '集中核对新医嘱 (3)', exact: true })
        await expect(trigger).toBeFocused()
        await trigger.click()
        await page.setViewportSize({ width: 480, height: 900 })
        await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
        await expect(confirm).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath('verification-review-125.png'), animations: 'disabled' })
        await page.evaluate(() => { document.documentElement.style.zoom = '' })
        await page.setViewportSize({ width: 390, height: 844 })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
    expect(reviewedLayout).toBe(true)
    expect(errors).toEqual([])
    expect(pixelRequests).toEqual([])
  })
  if (version === '19') test('十一条医嘱仅全选当前页，跨页搜索保留选择且完整核对清单独立滚动', async ({ page, browserApp }, testInfo) => {
    test.setTimeout(60_000)
    const s = await prepareOrderVerificationBatchPatient(page, browserApp)
    await s.api.login('inpatient-doctor')
    for (let index = 0; index < 8; index += 1) {
      const clinical = inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json())
      const response = await s.api.post(`${s.path}/orders/issue`, { encounterVersion: clinical.encounterVersion, duration: 'temporary',
        selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: index + 4 } })
      expect(response.status()).toBe(200)
      inpatientFullClinicalResponseSchema.parse(await response.json())
    }
    await s.api.login('ward-nurse')
    await page.route(`${browserApp.origin}/verification-list-contract`, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await page.setViewportSize({ width: 1101, height: 1000 })
    await page.goto(`${browserApp.origin}/verification-list-contract`)
    await openQueue(page)
    await page.getByRole('button', { name: new RegExp(s.name) }).click()
    await selectInpatientStage(page, '诊断医嘱')
    const verification = page.getByRole('region', { name: '新医嘱校对', exact: true })
    const drafts = verification.getByRole('region', { name: '待校对清单', exact: true })
    await expect(verification.getByRole('checkbox', { name: /^选择校对：/ })).toHaveCount(10)
    await verification.getByRole('button', { name: '全选当前页可校对医嘱', exact: true }).click()
    await expect(drafts).toContainText('待校对清单 (10/20) · 已选 10')
    await verification.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(verification.getByRole('checkbox', { name: /^选择校对：/ })).toHaveCount(1)
    await expect(verification.getByRole('checkbox', { name: /^选择校对：/ })).not.toBeChecked()
    await verification.getByRole('checkbox', { name: /^选择校对：/ }).check()
    await expect(drafts).toContainText('待校对清单 (11/20) · 已选 11')
    await verification.getByLabel('搜索待校对医嘱', { exact: true }).fill('对乙酰氨基酚')
    await expect(verification.getByRole('checkbox', { name: /^选择校对：/ })).toHaveCount(1)
    await expect(drafts.getByRole('checkbox', { name: /^清单选择：/ })).toHaveCount(11)
    await expect(drafts).toContainText('已选 11')
    await page.getByRole('button', { name: '集中核对新医嘱 (11)', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '集中核对新医嘱', exact: true })
    await expect(dialog.getByRole('article')).toHaveCount(11)
    const root = page.locator('.clinmesh-web-root')
    for (const width of [1101, 826]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1000 })
      await root.evaluate((element, value) => { element.classList.toggle('dark', value === 'dark'); element.setAttribute('data-theme', value) }, theme)
      const body = dialog.locator('.overflow-y-auto')
      await dialog.getByRole('button', { name: '确认校对 11 条新医嘱', exact: true }).click({ trial: true })
      const before = await dialog.getByRole('heading', { name: '集中核对新医嘱', exact: true }).boundingBox()
      expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
      await body.evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect(dialog.getByRole('article').last()).toBeInViewport()
      const after = await dialog.getByRole('heading', { name: '集中核对新医嘱', exact: true }).boundingBox()
      expect(after!.y).toBe(before!.y)
      await expect(dialog.getByRole('button', { name: '确认校对 11 条新医嘱', exact: true })).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`verification-long-list-${width}-${theme}.png`), animations: 'disabled' })
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(drafts).toContainText('已选 11')
    const final = inpatientFullClinicalSchema.parse(await (await s.api.get(`${s.path}/clinical`)).json())
    expect(final.orders.filter(order => order.state === 'signed')).toHaveLength(11)
    expect(final.executions).toEqual([])
    expect(final.charges).toEqual([])
  })
})
