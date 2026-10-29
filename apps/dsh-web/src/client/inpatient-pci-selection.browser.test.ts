import { test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { runPciSelectionJourney } from '../../../web/e2e/inpatient-pci-selection.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`PCI parameter confirmation React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('ShadowRoot 住院页面手工确认参数并保留候选、缺项与历史', async ({ page, browserApp }) => {
    await page.route(`${browserApp.origin}/pci-selection-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runPciSelectionJourney(page, browserApp, async () => {
      await page.goto(`${browserApp.origin}/pci-selection-contract`)
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    })
  })
})
