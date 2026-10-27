import { expect, test } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { prepareDrgReviewBrowser, runDrgReviewJourney } from '../../../web/e2e/inpatient-drg-review.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test(`React ${version} Surface术后核查处置与责任交接`, async ({ page, pciAgentApp }) => {
  test.setTimeout(60_000)
  const artifact = await buildInpatientPciFixture(version), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const prepared = await prepareDrgReviewBrowser(pciAgentApp)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route(`${pciAgentApp.origin}/review-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
  await runDrgReviewJourney(page, pciAgentApp, prepared, async () => {
    await page.goto(`${pciAgentApp.origin}/review-contract`)
    await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
  })
  expect(errors).toEqual([])
})
