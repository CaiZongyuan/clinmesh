import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { pharmacyQueueSchema } from '@clinmesh/contracts/his'
import { startBillingBrowserServer } from '../../../web/e2e/billing-payments.fixture.ts'
import { startPharmacyCardServer } from '../../../web/e2e/pharmacy-card.fixture.ts'
import { buildNonDoctorCard, mountNonDoctorCard } from './non-doctor-card.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`approved outpatient funds layout on React ${version}`, () => {
  test.beforeAll(async () => { await buildNonDoctorCard(version) })
  test('keeps four billing states in one row and payment controls usable with large English text', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await page.setViewportSize({ width: 826, height: 900 })
      await mountNonDoctorCard(page, version, server, 'cashier', {}, { locale: 'en-US' })
      const root = page.locator('.clinmesh-web-root')
      await root.evaluate(element => {
        element.setAttribute('data-font-size', 'large')
        const shadow = element.getRootNode()
        if (!(shadow instanceof ShadowRoot) || !(shadow.host instanceof HTMLElement)) throw new Error('Expected Surface host')
        shadow.host.style.width = '826px'
      })
      const states = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: 'Pending', exact: true }) })
      await expect(states.getByRole('tab').first()).toHaveCSS('font-size', '17.5px')
      const positions = await states.getByRole('tab').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().y))
      expect(positions).toHaveLength(4)
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1)
      for (const label of ['Paid', 'Declined', 'Unknown result', 'Pending']) {
        await states.getByRole('tab', { name: label, exact: true }).click()
        await expect(states.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true')
      }
      const amount = page.getByLabel('Synthetic cash', { exact: true })
      await amount.fill('20')
      await expect(amount).toHaveValue('20')
      await page.getByRole('button', { name: 'Preview payment', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Payment preview', exact: true })).toBeVisible()
      await expect.poll(() => root.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    } finally { await server.close() }
  })

  test('shows one real review outcome and medication row controls at 826px, retaining reviewed writes', async ({ page }) => {
    const server = await startPharmacyCardServer(page, fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await page.setViewportSize({ width: 826, height: 900 })
      await mountNonDoctorCard(page, version, server, 'pharmacist')
      await page.locator('.clinmesh-web-root').evaluate(element => {
        const shadow = element.getRootNode()
        if (!(shadow instanceof ShadowRoot) || !(shadow.host instanceof HTMLElement)) throw new Error('Expected Surface host')
        shadow.host.style.width = '826px'
      })
      await page.getByLabel('审核意见', { exact: true }).fill('合成药师已核对诊断、剂量与禁忌。')
      const action = page.getByRole('region', { name: '当前操作', exact: true })
      await action.getByRole('button', { name: '审核处方', exact: true }).click()
      await action.getByRole('button', { name: '审核通过', exact: true }).click()
      const review = page.getByRole('status', { name: '处方审核结论', exact: true })
      await expect(review).toContainText('合成药师已核对诊断、剂量与禁忌。')
      await expect(review.locator('time')).toHaveText(/2026\/.*\d{1,2}:\d{2}:\d{2}/)
      await expect(page.getByText('处方审核通过', { exact: true })).toHaveCount(1)
      const row = page.getByRole('row').filter({ has: page.getByRole('combobox', { name: /^库存批次/ }) })
      const lot = row.getByRole('combobox', { name: /^库存批次/ })
      const quantity = row.getByLabel(/^本次发放数量/)
      await expect(lot).toContainText(server.item.medications[0]!.lots[0]!.lotNumber)
      await expect(quantity).toHaveValue('10')
      const chosenLot = server.item.medications[0]!.lots[0]!
      await expect(page.getByText(chosenLot.lotNumber, { exact: true })).toHaveCount(0)
      await quantity.fill('4')
      await action.getByRole('button', { name: '审阅发药', exact: true }).click()
      await expect(action).toContainText(`本次 4`)
      await action.getByRole('button', { name: '取消', exact: true }).click()
      const unchanged = pharmacyQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/pharmacy/queue?status=pending`)).json())
      expect(unchanged.items[0]!.medications[0]!.dispensedQuantity).toBe(0)
      for (const theme of ['light', 'dark']) {
        await page.locator('.clinmesh-web-root').evaluate((element, selected) => {
          element.classList.toggle('dark', selected === 'dark'); element.setAttribute('data-theme', selected)
        }, theme)
        await expect.poll(() => row.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        await expect(quantity).toBeVisible()
        await expect(lot).toBeVisible()
        if (version === '19') await page.screenshot({ path: test.info().outputPath(`approved-pharmacy-826-${theme}.png`), animations: 'disabled' })
      }
    } finally { await server.close() }
  })
})
