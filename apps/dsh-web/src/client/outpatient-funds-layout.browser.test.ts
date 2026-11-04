import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { pharmacyQueueSchema } from '@clinmesh/contracts/his'
import { startBillingBrowserServer } from '../../../web/e2e/billing-payments.fixture.ts'
import { startPharmacyCardServer } from '../../../web/e2e/pharmacy-card.fixture.ts'
import { buildNonDoctorCard, mountNonDoctorCard } from './non-doctor-card.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`approved outpatient funds layout on React ${version}`, () => {
  test.beforeAll(async () => { await buildNonDoctorCard(version) })
  test('收费头部保持紧凑单行、主区只有账单标题，选中筛选文字完整', async ({ page }) => {
    const server = await startBillingBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
    try {
      await page.setViewportSize({ width: 1200, height: 950 })
      await mountNonDoctorCard(page, version, server, 'cashier', {}, { fullWorkspace: true })
      const root = page.locator('.clinmesh-web-root')
      const header = root.locator('.clinmesh-card-patient')
      await expect(header).toContainText('¥68.00')
      for (const width of [1101, 826]) for (const theme of ['light', 'dark']) {
        await root.evaluate((element, { width, theme }) => {
          const shadow = element.getRootNode()
          if (!(shadow instanceof ShadowRoot) || !(shadow.host instanceof HTMLElement)) throw new Error('Expected Surface host')
          shadow.host.style.width = `${width}px`
          element.classList.toggle('dark', theme === 'dark')
        }, { width, theme })
        const name = await header.getByRole('heading').first().boundingBox()
        const description = await header.getByText('发热检验组合', { exact: true }).boundingBox()
        const total = await header.getByText(/费用合计/).boundingBox()
        expect.soft(Math.abs(name!.y + name!.height / 2 - description!.y - description!.height / 2), `${width}/${theme}: name/description`).toBeLessThanOrEqual(4)
        expect.soft(Math.abs(name!.y + name!.height / 2 - total!.y - total!.height / 2), `${width}/${theme}: name/total`).toBeLessThanOrEqual(4)
        expect.soft((await header.boundingBox())!.height).toBeLessThanOrEqual(72)
        expect.soft(await page.getByRole('heading', { name: '支付处理', exact: true }).count()).toBe(0)
        await expect(page.getByRole('heading', { name: '本次就诊账单', exact: true })).toHaveCount(1)
        const category = page.getByRole('combobox', { name: '费用类别', exact: true })
        const mode = page.getByRole('combobox', { name: '门诊与住院', exact: true })
        expect.soft(Math.abs((await mode.boundingBox())!.y - (await category.boundingBox())!.y)).toBeLessThanOrEqual(1)
        for (const filter of [mode, category]) expect.soft(await filter.evaluate(element => {
          const value = element.querySelector('[data-slot="select-value"]')!
          const box = value.getBoundingClientRect(), trigger = element.getBoundingClientRect()
          const range = document.createRange(); range.selectNodeContents(value)
          return [...range.getClientRects()].every(rect => rect.width === 0 || rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= trigger.top && rect.bottom <= trigger.bottom)
        }), `${width}/${theme}: 检验费用`).toBe(true)
        if (version === '19' && process.env.CLINMESH_CAPTURE_OUTPATIENT_DETAILS === '1' && (width === 1101 && theme === 'light' || width === 826 && theme === 'dark')) {
          await root.screenshot({ path: test.info().outputPath(`review-billing-${width}-${theme}.png`), animations: 'disabled' })
        }
      }
    } finally { await server.close() }
  })
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
