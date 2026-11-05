import { selectInpatientStage } from './inpatient-ui.ts'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
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
  const { s, stay, admission } = await prepareDrgAgentStay(app)
  await loginPciBrowser(page, app, 'inpatient-doctor')
  await page.goto(`${app.origin}/inpatient`)
  await page.getByRole('button', { name: new RegExp(admission.patientName) }).click()
  await selectInpatientStage(page, '手术')
  const stepTwo = page.getByRole('region', { name: '手术耗材', exact: true })
  await stepTwo.getByRole('spinbutton', { name: /预计数量：.*球囊/ }).fill('0')
  await stepTwo.getByRole('spinbutton', { name: /预计数量：.*支架/ }).fill('0')
  await stepTwo.getByLabel('耗材清单说明', { exact: true }).fill('仅确认本次已认可的导丝和导管')
  await page.getByRole('region', { name: '当前操作', exact: true }).getByRole('button', { name: '确认并预留', exact: true }).click()
  await expect(stepTwo).toContainText('已为本计划预留')
  const reserved = await s.read('inpatient-doctor', `${stay.path}/drg/reservations`, inpatientMaterialReservationListSchema)
  expect(reserved.reservations.filter(item => item.status === 'reserved')).toHaveLength(2)
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
