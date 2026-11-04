import { expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { runDrgSummaryJourney } from '../../../web/e2e/inpatient-drg-summary.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`病案与医保四格摘要 React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('共享真实归档事实，宽窄布局和审阅焦点保持', async ({ page, browserApp }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(`${browserApp.origin}/drg-summary-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runDrgSummaryJourney(page, browserApp, info, { mount: async () => {
      await page.goto(browserApp.origin + '/drg-summary-contract')
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
      await expect(page.locator('.clinmesh-card-workspace')).toBeVisible()
      expect(await page.locator('.clinmesh-card-workspace').evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    } })
    expect(errors).toEqual([])
  })
})
