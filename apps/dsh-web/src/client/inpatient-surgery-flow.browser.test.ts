import { test } from '../../../web/e2e/inpatient-pci-ai.fixture.ts'
import { runSurgeryFlowJourney } from '../../../web/e2e/inpatient-surgery-flow.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'
for (const version of ['18', '19']) test.describe(`Surgery flow React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('ShadowRoot手术全程与术中完成双宽浅深、默认完成及术后核查', async ({ page, pciAiApp }, info) => {
    test.setTimeout(360_000)
    await page.route(`${pciAiApp.origin}/inpatient`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><style>${artifact.styles}</style></head><body style="margin:0"><script>${artifact.code.replaceAll('</script', '<\\\\/script')}</script></body></html>` }))
    await runSurgeryFlowJourney(page, pciAiApp, info)
  })
})
