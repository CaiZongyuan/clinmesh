import { expect, test } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { prepareDispenseBatchPatient, runDispenseBatchJourney } from '../../../web/e2e/inpatient-dispense-batch.journey.ts'
import { buildNonDoctorCard } from './non-doctor-card.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`React ${version} Surface 真实药房集中发药`, () => {
  let artifact: Awaited<ReturnType<typeof buildNonDoctorCard>>
  test.beforeAll(async () => { test.setTimeout(60_000); artifact = await buildNonDoctorCard(version) })
  test('完整RoleWorkspace住院模式在窄屏明暗、125%和键盘下核对三药并恢复原回执', async ({ page, pciApp }, testInfo) => {
    test.setTimeout(90_000)
    const errors: string[] = [], pixelRequests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/\/(?:pixels|tiles|dicom)(?:\/|\?)/, async route => { pixelRequests.push(new URL(route.request().url()).pathname); await route.abort() })
    const s = await prepareDispenseBatchPatient(page, pciApp, { name: '合成集中发药长中文姓名患者（逐项核对药品剂量、库存批次、效期及计划执行时点）' })
    const url = `${pciApp.origin}/dispense-batch-contract`
    // 持续提供同一真实 RoleWorkspace，原生 reload 才会重新挂载并读取原草稿。
    await page.route(url, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="UTF-8"><style>body{margin:0}</style><style>${artifact.styles}</style></head><body><script>window.nonDoctorFullWorkspace=true;${artifact.script.replaceAll('</script', '<\\/script')};document.body.firstElementChild.style.cssText='height:100vh;width:100%';</script></body></html>` }))
    await page.setViewportSize({ width: 390, height: 844 })
    let reviewed = false
    const evidence = await runDispenseBatchJourney(page, s, async () => { await page.goto(url) }, async caption => {
      const root = page.locator('.clinmesh-web-root')
      await root.evaluate(element => { element.setAttribute('data-font-size', 'large') })
      if (caption.startsWith('住院药房选择')) await page.screenshot({ path: testInfo.outputPath('dispense-drafts-390.png'), animations: 'disabled' })
      const dialog = page.getByRole('dialog', { name: '集中发药核对', exact: true })
      if (await dialog.isVisible() && !reviewed) {
        reviewed = true
        expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        const confirm = dialog.getByRole('button', { name: '确认发药', exact: true })
        const body = dialog.locator('.overflow-y-auto')
        for (const width of [390, 826, 1101]) for (const theme of ['light', 'dark']) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
          await root.evaluate((element, value) => { element.classList.toggle('dark', value === 'dark'); element.setAttribute('data-theme', value) }, theme)
          await confirm.click({ trial: true })
          const bounds = await dialog.boundingBox()
          expect(bounds!.x).toBeGreaterThanOrEqual(0)
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
          expect(bounds!.y).toBeGreaterThanOrEqual(0)
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(width === 390 ? 844 : 1000)
          const before = await dialog.getByRole('heading', { name: '集中发药核对', exact: true }).boundingBox()
          await body.evaluate(element => { element.scrollTop = element.scrollHeight })
          await expect(dialog.getByRole('article').last()).toBeInViewport()
          await expect(confirm).toBeInViewport()
          expect((await dialog.getByRole('heading', { name: '集中发药核对', exact: true }).boundingBox())!.y).toBe(before!.y)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: testInfo.outputPath(`dispense-review-${width}-${theme}.png`), animations: 'disabled' })
        }
        await page.setViewportSize({ width: 390, height: 844 })
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        const trigger = page.getByRole('button', { name: '集中发药', exact: true })
        await expect(trigger).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(dialog).toBeVisible()
        await page.setViewportSize({ width: 480, height: 900 })
        await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
        await confirm.click({ trial: true })
        await expect(confirm).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath('dispense-review-125-dark.png'), animations: 'disabled' })
        await page.evaluate(() => { document.documentElement.style.zoom = '' })
        await page.setViewportSize({ width: 390, height: 844 })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
    expect(reviewed).toBe(true)
    expect(evidence).toMatchObject({ posts: 3, dispenses: 3, quantities: [1, 1, 2], charges: 3, chargesFen: 270 })
    expect(errors).toEqual([])
    expect(pixelRequests).toEqual([])
  })
})
