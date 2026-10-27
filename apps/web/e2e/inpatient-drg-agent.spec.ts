import { test, loginPciBrowser } from './inpatient-pci.fixture.ts'
import { runDrgAgentJourney, runDrgAgentInvalidationJourney } from './inpatient-drg-agent.journey.ts'

test('真实住院入口生成并核验术前建议，人工确认丢回执恢复', async ({ page, pciAgentApp: app }) => {
  await runDrgAgentJourney(page, app, async (role, name) => {
    await loginPciBrowser(page, app, role)
    await page.goto(`${app.origin}/inpatient`)
    await page.getByRole('button', { name: new RegExp(name) }).click()
  })
})

test('真实住院参数变化使旧建议失效，保留原计划与证据版本', async ({ page, pciAgentApp: app }) => {
  await runDrgAgentInvalidationJourney(page, app, async (role, name) => {
    await loginPciBrowser(page, app, role)
    await page.goto(`${app.origin}/inpatient`)
    await page.getByRole('button', { name: new RegExp(name) }).click()
  })
})
