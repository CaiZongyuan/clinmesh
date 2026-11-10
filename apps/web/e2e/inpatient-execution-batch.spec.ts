import { expect, test } from './inpatient-pci.fixture.ts'
import { prepareInpatientExecutionBatch } from './inpatient-execution-batch.journey.ts'

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
