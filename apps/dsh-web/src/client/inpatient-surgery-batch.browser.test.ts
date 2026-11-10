import { expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { prepareSurgeryBatchPatient, runSurgeryBatchJourney } from '../../../web/e2e/inpatient-surgery-batch.journey.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`React ${version} Surface 手术双清单`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => {
    test.setTimeout(60_000)
    artifact = await buildInpatientDrgFixture(version)
  })
  test('390宽同窗连续选材、焦点回位、刷新私稿与整台原回执恢复', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const s = await prepareSurgeryBatchPatient(page, browserApp)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route(`${browserApp.origin}/surgery-batch-contract`, route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`,
    }))
    await runSurgeryBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/surgery-batch-contract`) }, async () => {
      const dialog = page.getByRole('dialog', { name: '整台补录', exact: true })
      if (await dialog.isVisible()) expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      const picker = page.getByRole('dialog', { name: '选择最终耗材', exact: true })
      if (await picker.isVisible()) {
        expect(await picker.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        await picker.getByRole('button', { name: /^加入/ }).last().scrollIntoViewIfNeeded()
        await expect(picker.getByRole('button', { name: /^加入/ }).last()).toBeInViewport()
        await expect(picker.getByRole('button', { name: '完成选择', exact: true })).toBeInViewport()
        await page.setViewportSize({ width: 480, height: 900 })
        await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
        await picker.getByRole('button', { name: /^加入/ }).last().scrollIntoViewIfNeeded()
        await expect(picker.getByRole('button', { name: /^加入/ }).last()).toBeInViewport()
        await expect(picker.getByRole('button', { name: '完成选择', exact: true })).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.evaluate(() => { document.documentElement.style.zoom = '' })
        await page.setViewportSize({ width: 390, height: 844 })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
    expect(errors).toEqual([])
  })
})
