import { expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { prepareReservationBatchPatient, runReservationBatchJourney } from '../../../web/e2e/inpatient-reservation-batch.journey.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`React ${version} Surface 连续手工预留`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => { test.setTimeout(60_000); artifact = await buildInpatientDrgFixture(version) })
  test('390宽连续选材、私稿重开、双原回执恢复和计划隔离', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const s = await prepareReservationBatchPatient(page, browserApp)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route(`${browserApp.origin}/reservation-batch-contract`, route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html data-view="workspace"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`,
    }))
    await runReservationBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/reservation-batch-contract`) }, async () => {
      for (const name of ['手工预留维护', '选择预留耗材']) {
        const dialog = page.getByRole('dialog', { name, exact: true })
        if (await dialog.isVisible()) {
          expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
          const bounds = await dialog.boundingBox()
          expect(bounds!.x).toBeGreaterThanOrEqual(0)
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
        }
      }
      const picker = page.getByRole('dialog', { name: '选择预留耗材', exact: true })
      if (await picker.isVisible()) {
        await picker.getByRole('button', { name: /^加入/ }).last().scrollIntoViewIfNeeded()
        await expect(picker.getByRole('button', { name: '完成选择', exact: true })).toBeInViewport()
        await page.setViewportSize({ width: 480, height: 900 })
        await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
        await picker.getByRole('button', { name: /^加入/ }).last().scrollIntoViewIfNeeded()
        await expect(picker.getByRole('button', { name: '完成选择', exact: true })).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await picker.getByRole('button', { name: '完成选择', exact: true }).click()
        await expect(picker).toBeHidden()
        await page.getByRole('button', { name: '添加预留耗材', exact: true }).click()
        await expect(picker).toBeVisible()
        await page.evaluate(() => { document.documentElement.style.zoom = '' })
        await page.setViewportSize({ width: 390, height: 844 })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }, { damageReleaseDraft: version === '19' })
    expect(errors).toEqual([])
  })
})
