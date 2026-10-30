import { expect, test } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { prepareDrgReviewBrowser, runDrgReviewJourney, runMedicalRecordsReviewJourney } from '../../../web/e2e/inpatient-drg-review.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`React ${version} Surface术后复查`, () => {
  test.describe.configure({ mode: 'default' })
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    artifact = await buildInpatientPciFixture(version)
  })
  test('术后核查处置与责任交接', async ({ page, pciAgentApp }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
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

  test('病案岗位处理分组待办与交接', async ({ page, pciAgentApp }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(`${pciAgentApp.origin}/medical-record-review-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runMedicalRecordsReviewJourney(page, pciAgentApp, async () => {
      await page.goto(`${pciAgentApp.origin}/medical-record-review-contract`)
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    })
    expect(errors).toEqual([])
  })
})
