import { expect, test } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { runEquivalentMaterialJourney } from '../../../web/e2e/inpatient-equivalent-materials.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`严格等效耗材 React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('近支付参考时人工采用、换回、确认预留与术中选择保持同数量', async ({ page, pciAgentApp: app }, info) => {
    await page.route(`${app.origin}/equivalent-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runEquivalentMaterialJourney(page, app, info, async () => {
      await page.goto(app.origin + '/equivalent-contract')
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
      await expect(page.locator('.clinmesh-card-workspace')).toBeVisible()
    })
  })
})
