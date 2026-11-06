import { selectWorkspaceMode, selectInpatientStage } from './inpatient-ui.ts'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { expect, loginPciBrowser, test } from './inpatient-pci.fixture.ts'
import { prepareDrgReviewBrowser, runDrgReviewJourney, runMedicalRecordsReviewJourney } from './inpatient-drg-review.journey.ts'
import { runMaterialPlanReviewJourney } from './inpatient-material-plan-review.journey.ts'

test('医生只确认一次耗材清单，完成手术后按原确认来源核查数量与未用差异', async ({ page, pciAgentApp }) => {
  test.setTimeout(120_000)
  await runMaterialPlanReviewJourney(page, pciAgentApp, () => page.goto(`${pciAgentApp.origin}/inpatient`).then(() => undefined))
})

test('病案岗位从病案页处理分组待办并交接未解决责任', async ({ page, pciAgentApp }) => {
  await runMedicalRecordsReviewJourney(page, pciAgentApp, () => page.goto(`${pciAgentApp.origin}/inpatient`).then(() => undefined))
})

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
  await selectWorkspaceMode(page, '住院')
  await page.getByRole('button', { name: `查看${prepared.admission.patientName}`, exact: true }).click()
  await selectInpatientStage(page, "费用")
  await expect(page.getByRole('region', { name: '费用差异核对', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '住院费用明细', exact: true })).toContainText('关联退费')
  const cashierReviewRaw = await (await f.request('cashier', `${prepared.stay.path}/drg/review`)).text()
  expect(cashierReviewRaw).not.toContain('synthetic-ivus-report')
  expect(cashierReviewRaw).not.toContain('LAD')
  const cashierReview = inpatientDrgReviewSchema.parse(JSON.parse(cashierReviewRaw))
  expect(cashierReview.model).toBeNull()
  const chargeTodo = cashierReview.todos.find(todo => todo.ownerRole === 'cashier')!
  expect(chargeTodo.explanation).toContain('耗材有效使用与正式收费净额不一致')
  expect((await f.request('cashier', `${prepared.stay.path}/drg/review/todos/act`, {
    todoId: chargeTodo.id, expectedTodoVersion: chargeTodo.version, expectedFingerprint: cashierReview.fingerprint!, action: 'in-progress', note: '收费员核对原账与更正来源',
  })).status).toBe(200)
  const after = await f.read('cashier', `${prepared.stay.path}/drg/review`, inpatientDrgReviewSchema)
  expect(after.todos.find(todo => todo.key === chargeTodo.key)?.status).toBe('in-progress')
  await page.goto('about:blank')
})
