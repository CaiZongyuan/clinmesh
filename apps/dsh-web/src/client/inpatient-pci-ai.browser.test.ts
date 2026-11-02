import { test } from '../../../web/e2e/inpatient-pci-ai.fixture.ts'
import { runPciAiJourney } from '../../../web/e2e/inpatient-pci-ai.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`PCI AI review React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { artifact = await buildInpatientPciFixture(version) })
  test('ShadowRoot造影来源、指南原文、一次确认和术中术后费用贯通', async ({ page, pciAiApp }) => {
    await page.route(`${pciAiApp.origin}/inpatient`, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await runPciAiJourney(page, pciAiApp)
  })
})
