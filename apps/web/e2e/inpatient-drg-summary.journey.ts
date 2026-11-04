import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { inpatientDrgPayerReviewPreviewSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { archiveDrgBrowserPatient, createDrgBrowserPatient } from './inpatient-drg.fixture.ts'

const money = (fen: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(fen / 100)

async function expectFourFacts(summary: Locator, columns: number) {
  const terms = summary.getByRole('term')
  await expect(terms).toHaveCount(4)
  await expect.poll(() => terms.evaluateAll(elements => new Set(elements.map(element => Math.round(element.getBoundingClientRect().x))).size)).toBe(columns)
  const clipped = await terms.evaluateAll(elements => elements.flatMap(element => {
    const cell = element.parentElement!
    const bounds = cell.getBoundingClientRect(), range = document.createRange()
    range.selectNodeContents(cell)
    return Array.from(range.getClientRects()).filter(rect => rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)).map(() => cell.textContent)
  }))
  expect(clipped).toEqual([])
}

/** Web 和双版本 Surface 复用真实归档与只读投影；只截图病案和医保文字界面。 */
export async function runDrgSummaryJourney(page: Page, app: { origin: string; password: string }, info: TestInfo, options: {
  mount(role: 'medical-records' | 'medical-insurance'): Promise<void>
  screenshots?: boolean
}) {
  const record = await createDrgBrowserPatient(page, app, '合成四格分组患者')
  await archiveDrgBrowserPatient(record)
  const archived = inpatientRecordSchema.parse(await (await record.api.get(record.path + '/record')).json())
  expect(archived.archive).toBeDefined()
  await record.api.login('medical-insurance')
  const preview = inpatientDrgPayerReviewPreviewSchema.parse(await (await record.api.get(record.path + '/drg/payer-review-preview')).json())
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/drg/payer-review')) writes.push(request.url()) })
  for (const role of ['medical-records', 'medical-insurance'] as const) {
    await record.api.login(role)
    await options.mount(role)
    if (role === 'medical-records') await page.getByRole('button', { name: `查看${record.name}`, exact: true }).click()
    const summary = page.getByRole('region', { name: role === 'medical-records' ? '病案 DRG 分组复核' : '归档时的分组与费用', exact: true })
    await expect(summary.getByRole('term')).toHaveCount(4)
    await expect(summary).toContainText(money(archived.archive!.snapshot.fees.chargesFen))
    await expect(summary).toContainText(money(preview.paymentEstimate!.referenceFen))
    if (role === 'medical-records') await expect(summary.getByLabel('当前资料未提供病组名称', { exact: true })).toHaveText('—')
    else {
      const payer = page.getByRole('region', { name: '医保办 DRG 复核', exact: true })
      await expect(payer.getByText(preview.drgCode, { exact: true }).filter({ visible: true })).toHaveCount(1)
      await expect(payer.getByRole('region', { name: '固定病例与编码来源', exact: true })).toHaveCount(0)
      const refresh = summary.getByRole('button', { name: '刷新复核依据', exact: true })
      expect(await refresh.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(await summary.evaluate(element => element.clientWidth / 2))
    }
    const workspace = page.locator('.clinmesh-card-workspace')
    await page.setViewportSize({ width: 1600, height: 1000 })
    for (const width of [1101, 826]) for (const theme of ['light', 'dark']) {
      await workspace.evaluate((element, targetWidth) => { (element as HTMLElement).style.width = `${targetWidth}px` }, width)
      await page.locator('.clinmesh-web-root').evaluate((element, currentTheme) => {
        element.classList.toggle('dark', currentTheme === 'dark')
        element.setAttribute('data-theme', currentTheme)
        element.setAttribute('data-font-size', 'standard')
      }, theme)
      await expectFourFacts(summary, width === 1101 ? 4 : 2)
      await expect.poll(() => workspace.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      if (options.screenshots && ((role === 'medical-records' && width === 1101 && theme === 'light') || (role === 'medical-insurance' && width === 826 && theme === 'dark'))) {
        await workspace.screenshot({ path: info.outputPath(`drg-summary-${role}-${width}-${theme}.png`), animations: 'disabled' })
      }
    }
    if (role === 'medical-insurance') {
      const payer = page.getByRole('region', { name: '医保办 DRG 复核', exact: true })
      await payer.locator('summary').filter({ hasText: /^查看归档病例与编码$/ }).click()
      await expect(payer.getByRole('region', { name: '固定病例与编码来源', exact: true })).toContainText('主诊断 I10.x09')
      await payer.getByLabel('核定说明', { exact: true }).fill('合成四格摘要核对')
      const bar = page.getByRole('region', { name: '当前操作', exact: true })
      await bar.getByRole('button', { name: '审阅模拟核定', exact: true }).click()
      await expect(bar.getByRole('button', { name: '提交模拟核定', exact: true })).toBeFocused()
      await expect(payer.getByTestId('drg-payer-preview')).toContainText(money(preview.simulatedPaymentFen))
      await bar.getByRole('button', { name: '返回', exact: true }).click()
      await expect(bar.getByRole('button', { name: '审阅模拟核定', exact: true })).toBeFocused()
      expect(writes).toEqual([])
    }
  }
}
