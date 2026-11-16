import { expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { runDrgProgressJourney } from '../../../web/e2e/inpatient-drg-progress.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`患者头部 DRG 进度 React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('真实病例所有页签常驻，费用同步，宽窄与浅深主题无溢出', async ({ page, browserApp }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(`${browserApp.origin}/drg-progress-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runDrgProgressJourney(page, browserApp, info, async () => {
      await page.goto(browserApp.origin + '/drg-progress-contract')
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
      await expect(page.locator('.clinmesh-card-workspace')).toBeVisible()
      expect(await page.locator('.clinmesh-card-workspace').evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    })
    expect(errors).toEqual([])
  })
})
