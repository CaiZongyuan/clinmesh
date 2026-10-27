import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { expect, loginPciBrowser, test } from './inpatient-pci.fixture.ts'
import { prepareDrgReviewBrowser, runDrgReviewJourney } from './inpatient-drg-review.journey.ts'

test('真实住院入口展示术后差异、已核验解释、岗位处置与未解决责任交接', async ({ page, pciAgentApp }) => {
  const prepared = await prepareDrgReviewBrowser(pciAgentApp)
  await runDrgReviewJourney(page, pciAgentApp, prepared, () => page.goto(`${pciAgentApp.origin}/inpatient`).then(() => undefined))
})

test('现金岗位仅看到财务疑点并可按本岗位处理，不返回临床参数或模型解释', async ({ page, pciAgentApp }) => {
  const prepared = await prepareDrgReviewBrowser(pciAgentApp), f = pciAgentApp.fixture
  const charge = (await f.read('cashier', `${prepared.stay.path}/charges`, inpatientChargesSchema)).charges.find(item => item.kind === 'material')!
  expect((await f.request('cashier', `${prepared.stay.path}/charges/reverse`, { chargeId: charge.id, expectedChargeVersion: charge.version, reason: '合成费用核对疑点' })).status).toBe(200)
  await loginPciBrowser(page, pciAgentApp, 'cashier')
  await page.goto(`${pciAgentApp.origin}/billing`)
  await page.getByRole('tab', { name: '住院费用', exact: true }).click()
  await page.getByRole('button', { name: `查看${prepared.admission.patientName}`, exact: true }).click()
  await page.getByRole('tab', { name: '费用', exact: true }).click()
  const panel = page.getByRole('region', { name: '住院费用核查待办', exact: true })
  await expect(panel).toContainText('耗材有效使用与正式收费净额不一致')
  await expect(panel).not.toContainText('synthetic-ivus-report')
  await expect(panel).not.toContainText('LAD')
  await expect(panel).not.toContainText('已核验解释')
  const todo = panel.locator('article').filter({ hasText: '耗材有效使用与正式收费净额不一致' })
  await todo.getByLabel('待办处理说明', { exact: true }).fill('收费员核对原账与更正来源')
  await todo.getByRole('button', { name: '标记处理中', exact: true }).click()
  await expect(todo.getByText('处理中', { exact: true })).toBeVisible()
  await page.goto('about:blank')
})
