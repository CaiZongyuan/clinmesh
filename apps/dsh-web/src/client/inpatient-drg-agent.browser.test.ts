import { test, loginPciBrowser } from '../../../web/e2e/inpatient-pci.fixture.ts'
import { runDrgAgentJourney, runDrgAgentRecoveryJourney, runDrgAgentInvalidationJourney } from '../../../web/e2e/inpatient-drg-agent.journey.ts'
import { buildInpatientPciFixture } from './inpatient-pci.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`Inpatient DRG recommendations React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientPciFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientPciFixture(version) })
  test('ShadowRoot 住院建议生成人工调整与确认', async ({ page, pciAgentApp: app }) => {
    await page.route(`${app.origin}/drg-agent-contract`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await runDrgAgentJourney(page, app, async (role, name) => {
      await loginPciBrowser(page, app, role)
      await page.goto(`${app.origin}/drg-agent-contract`)
      await page.getByRole('button', { name: new RegExp(name) }).click()
    })
  })
  test('ShadowRoot 耗材计划丢回执按原键恢复', async ({ page, pciAgentApp: app }) => {
    // 原意图跨刷新恢复需要两次真实页面挂载，沿用住院长旅程预算。
    test.setTimeout(60_000)
    await page.route(`${app.origin}/drg-agent-contract`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await runDrgAgentRecoveryJourney(page, app, async (role, name) => {
      await loginPciBrowser(page, app, role)
      await page.goto(`${app.origin}/drg-agent-contract`)
      await page.getByRole('button', { name: new RegExp(name) }).click()
    })
  })
  test('ShadowRoot 住院参数变化保留原计划与证据版本', async ({ page, pciAgentApp: app }) => {
    await page.route(`${app.origin}/drg-agent-contract`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>` }))
    await runDrgAgentInvalidationJourney(page, app, async (role, name) => {
      await loginPciBrowser(page, app, role)
      await page.goto(`${app.origin}/drg-agent-contract`)
      await page.getByRole('button', { name: new RegExp(name) }).click()
    })
  })
})
