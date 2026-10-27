import { test } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { runDrgUsageJourney } from '../../../web/e2e/inpatient-drg-usage.journey.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`inpatient DRG usage React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientDrgFixture(version) })
  test('实际模型用量在 Surface 中按病例归集并跨重启保留', async ({ page, pciAgentApp }) => {
    test.setTimeout(60_000)
    await page.route(`${pciAgentApp.origin}/drg-usage-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runDrgUsageJourney(page, pciAgentApp, async admissionId => {
      await page.goto(`${pciAgentApp.origin}/drg-usage-contract`)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.setContent(`<!doctype html><html data-admission-id="${admissionId}"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    })
  })
})
