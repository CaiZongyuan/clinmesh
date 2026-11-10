import { expect, test } from './inpatient-pci.fixture.ts'
import { prepareInpatientExecutionBatch, runInpatientExecutionBatchJourney, runInpatientExecutionRecoveryJourney } from './inpatient-execution-batch.journey.ts'

test('护士从三类真实待办进入独立给药窗口，未核实实际发生时不可选择且无全选', async ({ page, pciApp }) => {
  test.setTimeout(120_000)
  await prepareInpatientExecutionBatch(page, pciApp)
  await page.getByRole('button', { name: '集中记录给药', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '集中记录给药', exact: true })
  await expect(dialog).toBeVisible()
  const choices = dialog.getByRole('checkbox', { name: /^选择给药：/ })
  await expect(choices).toHaveCount(2)
  for (const choice of await choices.all()) { await expect(choice).not.toBeChecked(); await expect(choice).toBeDisabled() }
  await expect(dialog.getByRole('button', { name: /全选/ })).toHaveCount(0)
})

test('护士分别确认实际给药、实际教育与不同最终理由的 PRN，原执行和费用各保存一次', async ({ page, pciApp }) => {
  test.setTimeout(120_000)
  const subject = await prepareInpatientExecutionBatch(page, pciApp)
  await runInpatientExecutionBatchJourney(page, subject)
})

test('教育第二项真实保存后丢响应即停止，刷新只查原回执，余项重新核对确认', async ({ page, pciApp }) => {
  test.setTimeout(120_000)
  const subject = await prepareInpatientExecutionBatch(page, pciApp, { educationCount: 3 })
  await runInpatientExecutionRecoveryJourney(page, subject)
})
