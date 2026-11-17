import { expect, test } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { prepareDrgRecordChecksBrowser, runDrgRecordChecksJourney, runDrgRecordChecksReadFailureJourney } from '../../../web/e2e/inpatient-drg-record-checks.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`DRG record checks React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test.beforeEach(() => { test.setTimeout(60_000) })

  test(`React ${version} Surface无需跟进核对与按需解释`, async ({ page, pciAgentApp }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const prepared = await prepareDrgRecordChecksBrowser(pciAgentApp)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route(`${pciAgentApp.origin}/record-checks-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runDrgRecordChecksJourney(page, pciAgentApp, prepared, async () => {
      await page.goto(`${pciAgentApp.origin}/record-checks-contract`)
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    })
    expect(errors).toEqual([])
  })

  test(`React ${version} Surface核对读取失败与恢复`, async ({ page, pciAgentApp }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const prepared = await prepareDrgRecordChecksBrowser(pciAgentApp)
    await page.route(`${pciAgentApp.origin}/record-checks-failure-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runDrgRecordChecksReadFailureJourney(page, pciAgentApp, prepared, async () => {
      await page.goto(`${pciAgentApp.origin}/record-checks-failure-contract`)
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    })
    expect(errors).toEqual([])
  })
})
