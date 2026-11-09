import { expect, test } from '../../../web/e2e/fixtures.ts'
import { prepareOrderStopBatchPatient, runOrderStopBatchJourney } from '../../../web/e2e/inpatient-order-stop-batch.journey.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`React ${version} Surface 停嘱申请与独立核停`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => { test.setTimeout(60_000); artifact = await buildInpatientDrgFixture(version) })
  test('大字窄屏长理由独立滚动，原尝试恢复且退出后护士核停不带入医生草稿', async ({ page, browserApp }, testInfo) => {
    test.setTimeout(90_000)
    const errors: string[] = [], pixelRequests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/\/(?:pixels|tiles|dicom)(?:\/|\?)/, async route => { pixelRequests.push(new URL(route.request().url()).pathname); await route.abort() })
    const s = await prepareOrderStopBatchPatient(page, browserApp)
    s.commonReason = '合成长理由：本阶段治疗已结束，核对后停止当前医嘱，后续随访另行安排。'.repeat(9)
    s.overrideReason = '合成单项覆盖理由：教育内容已另作调整，保留既有发药及费用，后续执行由责任岗位重新核对。'.repeat(9)
    const url = `${browserApp.origin}/order-stop-batch-contract`
    await page.route(url, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await page.setViewportSize({ width: 390, height: 844 })
    const reviewed = new Set<string>()
    const evidence = await runOrderStopBatchJourney(page, s, async () => { await page.goto(url) }, async () => {
      const dialog = page.getByRole('dialog', { name: /^集中(?:申请|核对)停嘱$/ })
      if (await dialog.isVisible()) {
        const name = (await dialog.getByRole('heading').textContent())!
        if (!reviewed.has(name)) {
          reviewed.add(name)
          expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
          const root = page.locator('.clinmesh-web-root')
          await expect(root).toHaveAttribute('data-font-size', 'large')
          const confirmName = name === '集中申请停嘱' ? '确认申请 2 条停嘱' : '确认核对 2 条停嘱'
          const triggerName = `${name} (2)`
          const confirm = dialog.getByRole('button', { name: confirmName, exact: true })
          await confirm.click({ trial: true })
          const body = dialog.locator('.overflow-y-auto')
          expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
          const before = await dialog.getByRole('heading').boundingBox()
          await body.evaluate(element => { element.scrollTop = element.scrollHeight })
          await expect(dialog.getByRole('article').last()).toBeInViewport()
          expect((await dialog.getByRole('heading').boundingBox())!.y).toBe(before!.y)
          await expect(confirm).toBeInViewport()
          for (const theme of ['light', 'dark']) {
            await root.evaluate((element, value) => { element.classList.toggle('dark', value === 'dark'); element.setAttribute('data-theme', value) }, theme)
            await page.screenshot({ path: testInfo.outputPath(`${name}-390-${theme}.png`), animations: 'disabled' })
          }
          await page.keyboard.press('Escape')
          await expect(dialog).toBeHidden()
          const trigger = page.getByRole('button', { name: triggerName, exact: true })
          await expect(trigger).toBeFocused()
          await trigger.click()
          await page.setViewportSize({ width: 480, height: 900 })
          await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
          await confirm.click({ trial: true })
          await expect(confirm).toBeInViewport()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: testInfo.outputPath(`${name}-125-dark.png`), animations: 'disabled' })
          await page.evaluate(() => { document.documentElement.style.zoom = '' })
          await page.setViewportSize({ width: 390, height: 844 })
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
    expect(reviewed.size).toBe(2)
    expect(evidence).toMatchObject({ requestPosts: 2, verifyPosts: 2, stoppedOrders: 2, cancelledExecutions: 2, signedOrders: 1 })
    expect(errors).toEqual([])
    expect(pixelRequests).toEqual([])
  })
})
