import { expect, test } from './fixtures.ts'
import { signInCashier, startBillingBrowserServer } from './billing-payments.fixture.ts'

test('收费建议布局保留一行四状态、并排筛选和紧凑的收款及次要入口', async ({ page, webRoot }) => {
  const server = await startBillingBrowserServer(webRoot)
  try {
    await signInCashier(page, server)
    for (const width of [1101, 826]) {
      await page.setViewportSize({ width, height: 900 })
      const queue = page.locator('.clinmesh-card-queue')
      const title = await queue.getByRole('heading', { name: '收费队列', exact: true }).boundingBox()
      const count = await queue.getByText('1', { exact: true }).boundingBox()
      expect(Math.abs(title!.y + title!.height / 2 - count!.y - count!.height / 2)).toBeLessThan(2)
      const filters = await Promise.all(['门诊与住院', '费用类别'].map(name => queue.getByRole('combobox', { name, exact: true }).boundingBox()))
      expect(filters[0]!.y).toBe(filters[1]!.y)
      const states = await queue.getByRole('tab').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().y))
      expect(states).toHaveLength(4)
      expect(Math.max(...states) - Math.min(...states)).toBeLessThan(1)
      expect(await queue.getByRole('tab').evaluateAll(elements => elements.map(element => {
        const range = document.createRange(); range.selectNodeContents(element)
        return range.getClientRects().length
      }))).toEqual([1, 1, 1, 1])
      const fields = await Promise.all(['合成现金', '合成银行卡', '合成移动支付', '支付处理结果'].map(name => page.getByLabel(name, { exact: true }).boundingBox()))
      expect(fields[0]!.y).toBe(fields[1]!.y)
      expect(fields[2]!.y).toBe(fields[3]!.y)
      if (width === 1101) expect(fields[0]!.y).toBe(fields[3]!.y)
      const secondary = await Promise.all(['医保待遇', '支付尝试记录'].map(label => page.locator('summary').filter({ hasText: new RegExp(`^${label}$`) }).boundingBox()))
      expect(Math.max(...secondary.map(box => box!.y)) - Math.min(...secondary.map(box => box!.y))).toBeLessThan(1)
      await expect(page.getByText('留空默认按整笔未收金额收款；填写多分项可办理组合支付', { exact: true })).toHaveCount(1)
      await expect(page.getByRole('row', { name: '合计 ¥68.00 ¥0.00 ¥68.00', exact: true })).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: test.info().outputPath(`approved-billing-${width}.png`), animations: 'disabled' })
    }
  } finally { await server.close() }
})
