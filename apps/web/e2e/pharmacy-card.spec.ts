import { pharmacyQueueSchema } from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'
import { startPharmacyCardServer } from './pharmacy-card.fixture.ts'

test('药师从真实入口原位审核、部分发药和发完后回查，保留库存和键盘操作', async ({ page, webRoot }) => {
  const server = await startPharmacyCardServer(page, webRoot)
  try {
    await page.goto(`${server.origin}/pharmacy`)
    await expect(page.getByRole('heading', { name: '发药队列', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: '异常', exact: true })).toHaveCount(0)
    const pending = async () => pharmacyQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/pharmacy/queue?status=pending`)).json())
    const action = page.getByRole('region', { name: '当前操作', exact: true })
    await expect(action.getByRole('button', { name: '审阅处方审核', exact: true })).toBeDisabled()
    await page.getByLabel('审核意见', { exact: true }).fill('合成真实入口药师已核对诊断、剂量与禁忌')
    await action.getByRole('button', { name: '审阅处方审核', exact: true }).click()
    const approve = action.getByRole('button', { name: '审核通过', exact: true })
    await expect(approve).toBeFocused()
    expect((await pending()).items[0]?.review).toBeUndefined()
    await page.keyboard.press('Escape')
    await expect(action.getByRole('button', { name: '审阅处方审核', exact: true })).toBeFocused()
    await action.getByRole('button', { name: '审阅处方审核', exact: true }).click()
    await approve.click()
    await expect.poll(async () => (await pending()).items[0]?.status).toBe('awaiting-dispense')
    const medication = server.item.medications[0]!
    const quantity = page.getByLabel(`本次发放数量 · ${medication.nameZh}`, { exact: true })
    await quantity.fill('1001')
    await expect(quantity).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByText('库存仅剩 1000，请减少数量或选择其他批次。', { exact: true })).toBeVisible()
    await expect(action.getByRole('button', { name: '审阅发药', exact: true })).toBeDisabled()
    await quantity.fill('4')
    await action.getByRole('button', { name: '审阅发药', exact: true }).click()
    await expect(action).toContainText('确认后按以上批次扣减库存')
    expect((await pending()).items[0]?.medications[0]?.dispensedQuantity).toBe(0)
    await action.getByRole('button', { name: '确认发药', exact: true }).click()
    await expect.poll(async () => (await pending()).items[0]?.medications[0]?.remainingQuantity).toBe(6)
    await expect(quantity).toHaveValue('6')
    await expect(page.getByText('部分已发', { exact: true })).toBeVisible()
    await action.getByRole('button', { name: '审阅发药', exact: true }).click()
    await action.getByRole('button', { name: '确认发药', exact: true }).click()
    await expect.poll(async () => (await pending()).items.length).toBe(0)
    await page.getByRole('tab', { name: '已发药', exact: true }).click()
    await expect(page.getByText('库存 990', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '审阅发药', exact: true })).toHaveCount(0)
    const completed = pharmacyQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/pharmacy/queue?status=completed`)).json())
    expect(completed.items[0]?.medications[0]).toMatchObject({ dispensedQuantity: 10, remainingQuantity: 0 })
    for (const width of [944, 720, 400]) {
      await page.setViewportSize({ width, height: 900 })
      for (const [theme, label] of [['light', '亮色'], ['dark', '暗色']] as const) {
        await page.getByRole('button', { name: '用户菜单' }).click()
        await page.getByRole('menuitemradio', { name: label, exact: true }).click()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('menu')).toHaveCount(0)
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: test.info().outputPath(`pharmacy-${width}-${theme}.png`), animations: 'disabled' })
      }
    }
  } finally { await server.close() }
})
