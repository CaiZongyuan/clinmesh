import { test, loginPciBrowser } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { runDrgAgentJourney } from '../../../web/e2e/inpatient-drg-agent.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`Inpatient DRG recommendations React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('ShadowRoot 住院建议人工确认、原回执恢复与参数失效', async ({ page, pciAgentApp: app }) => {
    await page.route(`${app.origin}/drg-agent-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await runDrgAgentJourney(page, app, async (role, name) => {
      await loginPciBrowser(page, app, role)
      await page.goto(`${app.origin}/drg-agent-contract`)
      await page.setContent(`<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
      await page.getByRole('button', { name: new RegExp(name) }).click()
    })
  })
})
