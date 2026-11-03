import { test, expect } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { runInpatientDoctorPages } from '../../../web/e2e/inpatient-doctor-pages.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`住院医生六页 React ${version} Surface`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('ShadowRoot中逐页保留正文顺序、次级操作与宽窄明暗布局', async ({ page, browserApp }) => {
    test.setTimeout(120_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(`${browserApp.origin}/inpatient-doctor-pages-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runInpatientDoctorPages(page, browserApp, {
      mount: async () => {
        await page.goto(`${browserApp.origin}/inpatient-doctor-pages-contract`)
        await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
        await expect(page.locator('.clinmesh-card-workspace')).toBeVisible()
        expect(await page.locator('.clinmesh-card-workspace').evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        await page.locator('.clinmesh-web-root').evaluate(element => { element.setAttribute('data-font-size', 'standard') })
      },
      appearance: async theme => {
        await page.locator('.clinmesh-web-root').evaluate((element, theme) => {
          element.classList.toggle('dark', theme === 'dark')
          element.setAttribute('data-theme', theme)
        }, theme)
      },
    })
    expect(errors).toEqual([])
  })
})
