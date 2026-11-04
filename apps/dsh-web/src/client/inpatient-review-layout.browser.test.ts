import { expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { runInpatientReviewLayout } from '../../../web/e2e/inpatient-review-layout.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`住院细节复核 React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('紧凑医生头部与术前清单、单页药房在真实Surface保持可读', async ({ page, browserApp }, info) => {
    test.setTimeout(90_000)
    await page.route(`${browserApp.origin}/review-layout-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runInpatientReviewLayout(page, browserApp, info, {
      mount: async () => {
        await page.goto(`${browserApp.origin}/review-layout-contract`)
        await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
        await expect(page.locator('.clinmesh-card-workspace')).toBeVisible()
        await page.locator('.clinmesh-web-root').evaluate(element => { element.setAttribute('data-font-size', 'standard') })
      },
      appearance: async theme => {
        await page.locator('.clinmesh-web-root').evaluate((element, value) => {
          element.classList.toggle('dark', value === 'dark')
          element.setAttribute('data-theme', value)
        }, theme)
      },
    })
  })
})
