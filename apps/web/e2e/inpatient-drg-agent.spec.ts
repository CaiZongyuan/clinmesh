import { selectInpatientStage } from './inpatient-ui.ts'
import { expect, test, loginPciBrowser } from './inpatient-pci.fixture.ts'
import { prepareDrgAgentStay, runDrgAgentJourney, runDrgAgentRecoveryJourney, runDrgAgentInvalidationJourney } from './inpatient-drg-agent.journey.ts'

test('真实住院入口生成并核验术前建议，人工调整后确认计划', async ({ page, pciAgentApp: app }) => {
  await runDrgAgentJourney(page, app, async (role, name) => {
    await loginPciBrowser(page, app, role)
    await page.goto(`${app.origin}/inpatient`)
    await page.getByRole('button', { name: new RegExp(name) }).click()
  })
})

test('医生在真实住院页面只认可两项候选，生成并确认对应耗材计划', async ({ page, pciAgentApp: app }) => {
  const { admission } = await prepareDrgAgentStay(app)
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await page.goto(`${app.origin}/inpatient`)
  await page.getByRole('button', { name: new RegExp(admission.patientName) }).click()
  await selectInpatientStage(page, "手术")
  await page.getByText('PCI 选型参数与候选依据', { exact: true }).click()
  const parameters = page.getByRole('region', { name: 'PCI 参数与候选', exact: true })
  await parameters.getByRole('checkbox', { name: /球囊/ }).uncheck()
  await parameters.getByRole('checkbox', { name: /支架/ }).uncheck()
  await parameters.getByRole('button', { name: '确认 PCI 参数', exact: true }).click()
  await expect(parameters.getByText(/已确认参数 v2/)).toBeVisible()
  await selectInpatientStage(page, "DRG 预分组")
  await page.getByRole('button', { name: '开启本次住院跟进', exact: true }).click()
  const region = page.getByRole('region', { name: '住院耗材建议', exact: true })
  await expect(region.getByText("AI分析与核验已完成", { exact: true })).toBeVisible()
  await expect(region.getByRole('combobox', { name: /计划产品/ })).toHaveCount(2)
  await region.getByRole('textbox', { name: '医生确认说明', exact: true }).fill('仅确认本次已认可的导丝和导管')
  await region.getByRole('button', { name: '确认耗材计划', exact: true }).click()
  await expect(region.getByRole('region', { name: '已确认耗材计划', exact: true })).toContainText('仅确认本次已认可的导丝和导管')
  expect(app.modelFeatures).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
})

test('真实住院入口耗材计划丢回执后按原键恢复', async ({ page, pciAgentApp: app }) => {
  await runDrgAgentRecoveryJourney(page, app, async (role, name) => {
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
