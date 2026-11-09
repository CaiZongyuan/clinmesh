import { test } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { runDrgUsageJourney } from '../../../web/e2e/inpatient-drg-usage.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`inpatient DRG usage React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('实际用量在 Surface 中跨重启保留，双权限补算保持病例与任务', async ({ page, pciAgentApp }) => {
    test.setTimeout(60_000)
    await page.route(`${pciAgentApp.origin}/drg-usage-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runDrgUsageJourney(page, pciAgentApp, async (_admissionId, name) => {
      await page.goto(`${pciAgentApp.origin}/drg-usage-contract`)
      await page.setViewportSize({ width: 1101, height: 900 })
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
      await page.getByRole('button', { name: new RegExp(name) }).click()
    })
  })
})
