import { expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { runInpatientPrototypeMatrix } from '../../../web/e2e/inpatient-prototype-layout.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`住院七岗位原型 React ${version} Surface`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('真实七岗位在ShadowRoot两档宽度和明暗主题逐项对照并连续发药', async ({ page, browserApp }, info) => {
    test.setTimeout(180_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(`${browserApp.origin}/inpatient-prototype-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runInpatientPrototypeMatrix(page, browserApp, info, { prefix: `surface-react${version}`,
      mount: async () => {
        await page.goto(`${browserApp.origin}/inpatient-prototype-contract`)
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
