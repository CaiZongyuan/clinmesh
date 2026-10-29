import { test } from '../../../web/e2e/inpatient-material-estimate.fixture.ts'
import { runMaterialEstimateJourney } from '../../../web/e2e/inpatient-material-estimate.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`Inpatient material estimate React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('ShadowRoot 单次预计自动保存、刷新重算保留工作稿与整批确认', async ({ page, estimateApp: app }) => {
    test.setTimeout(90_000)
    await page.route(`${app.origin}/inpatient`, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await runMaterialEstimateJourney(page, app)
  })
})
