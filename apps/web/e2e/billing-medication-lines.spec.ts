import { billingQueueSchema } from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'
import { openBillingDetails } from './billing-payments.fixture.ts'
import { startPharmacyCardServer } from './pharmacy-card.fixture.ts'

test('收费员在单一账单核对真实药品明细，费用更正保留原处方单价与当前余额各自口径', async ({ page, webRoot }) => {
  const server = await startPharmacyCardServer(page, webRoot)
  try {
    const login = await page.request.post(`${server.origin}/api/auth/sign-in/email`, {
      headers: { origin: server.origin }, data: { email: 'cashier@demo.clinmesh.local', password: server.password },
    })
    expect(login.status()).toBe(200)
    const queue = billingQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/billing/queue?category=medication&status=paid`)).json())
    const charge = queue.items.find(item => item.caseId === server.item.caseId)!
    expect(charge.lines[0]).toMatchObject({ descriptionZh: '磷酸奥司他韦胶囊', quantity: 10, unitPriceFen: 760, subtotalFen: 7600 })
    await page.goto(`${server.origin}/billing`)
    await page.getByRole('combobox', { name: '费用类别', exact: true }).click()
    await page.getByRole('option', { name: '药品费用', exact: true }).click()
    await page.getByRole('tab', { name: '已缴', exact: true }).click()
    await page.locator(`[data-agent-selection="${charge.chargeItemId}"]`).click()
    const bill = page.getByRole('region', { name: '本次就诊账单', exact: true })
    const details = bill.getByRole('list', { name: '原处方明细', exact: true })
    await expect(details.getByText('磷酸奥司他韦胶囊', { exact: true })).toBeVisible()
    await expect(details.getByText('数量 10', { exact: true })).toBeVisible()
    await expect(details.getByText('原单价 ¥7.60', { exact: true })).toBeVisible()
    await expect(details.getByText('原小计 ¥76.00', { exact: true })).toBeVisible()
    await expect(bill.getByRole('table')).toHaveCount(1)
    await expect(bill.getByRole('row', { name: '合计 ¥76.00 ¥76.00 ¥0.00', exact: true })).toBeVisible()
    await expect(bill).not.toContainText(charge.chargeItemId)
    await expect(bill).not.toContainText(charge.lines[0]!.sourceReference)

    await openBillingDetails(page, '费用更正与退款')
    const corrections = page.getByRole('region', { name: '费用更正与退款', exact: true })
    await corrections.getByLabel('费用冲减金额（元）', { exact: true }).fill('16')
    await corrections.getByLabel('费用更正原因', { exact: true }).fill('合成核价后核准冲减十六元。')
    await corrections.getByRole('button', { name: '记录费用更正', exact: true }).click()
    await page.getByRole('region', { name: '确认费用更正', exact: true }).getByRole('button', { name: '确认费用更正', exact: true }).click()
    await expect(bill.getByRole('row', { name: '合计 ¥60.00 ¥76.00 ¥0.00', exact: true })).toBeVisible()
    await expect(details.getByText('原小计 ¥76.00', { exact: true })).toBeVisible()
    await page.locator('summary').filter({ hasText: /^费用更正与退款$/ }).click()
    for (const width of [1101, 826]) for (const [theme, label] of [['light', '亮色'], ['dark', '暗色']] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.getByRole('button', { name: '用户菜单' }).click()
      await page.getByRole('menuitemradio', { name: label, exact: true }).click()
      await page.keyboard.press('Escape')
      await page.locator('.clinmesh-card-content').evaluate(element => { element.scrollTop = 0 })
      await expect(details).toBeVisible()
      await expect.poll(() => bill.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: test.info().outputPath(`medication-bill-${width}-${theme}.png`), animations: 'disabled' })
    }
  } finally { await server.close() }
})
