import { test, loginPciBrowser } from './inpatient-pci.fixture.ts'
import { runDrgAgentJourney } from './inpatient-drg-agent.journey.ts'

test('真实住院入口生成并核验术前建议，人工确认丢回执恢复和参数失效保留原计划', async ({ page, pciAgentApp: app }) => {
  await runDrgAgentJourney(page, app, async (role, name) => {
    await loginPciBrowser(page, app, role)
    await page.goto(`${app.origin}/inpatient`)
    await page.getByRole('button', { name: new RegExp(name) }).click()
  })
})
