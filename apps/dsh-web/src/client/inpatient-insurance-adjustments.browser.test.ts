import { expect, test } from '../../../web/e2e/fixtures.ts'
import { prepareSettledInsurance } from '../../../web/e2e/inpatient-insurance-adjustments.fixture.ts'

import { buildInpatientFinanceFixture } from './inpatient-finance.browser.artifact.ts'
for (const version of ['18', '19']) test.describe(`inpatient insurance React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientFinanceFixture>>
  test.beforeAll(async () => { artifact = await buildInpatientFinanceFixture(version) })
  test(`后续医保补偿和新待遇审阅在 React ${version} 的 Surface 内保持焦点及冻结预览`, async ({ page, browserApp }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const { admission } = await prepareSettledInsurance(page, browserApp)
    await page.route(`${browserApp.origin}/insurance-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto(`${browserApp.origin}/insurance-contract`)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.setContent(`<!doctype html><html data-admission-id="${admission.id}"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    const panel = page.getByRole('region', { name: '后续财务更正', exact: true })
    await panel.getByLabel('更正金额（元）', { exact: true }).fill('10')
    await panel.getByLabel('财务更正原因', { exact: true }).fill('合成Surface医保更正')
    await panel.getByRole('button', { name: '审阅财务更正', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '提交财务更正', exact: true }).click()
    await panel.getByRole('button', { name: '审阅原待遇补偿', exact: true }).click()
    const compensation = page.getByRole('alertdialog', { name: '确认原待遇补偿', exact: true })
    expect(await compensation.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await expect.poll(() => compensation.evaluate(element => { const root = element.getRootNode(); return root instanceof ShadowRoot && element.contains(root.activeElement) })).toBe(true)
    await compensation.getByRole('button', { name: '确认补偿原待遇', exact: true }).click()
    await panel.getByRole('button', { name: '预览更正医保', exact: true }).click()
    const review = page.getByRole('alertdialog', { name: '确认更正医保待遇', exact: true })
    await expect(review.getByTestId('financial-insurance-review')).toContainText('48.00')
    const bounds = await review.evaluate(element => ({ inShadow: element.getRootNode() instanceof ShadowRoot, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.clientWidth, scroll: element.scrollWidth }))
    expect(bounds.inShadow).toBe(true); expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(390); expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1)
    await review.getByRole('button', { name: '确认更正待遇', exact: true }).click()
    await expect(review).toBeHidden()
    await expect(panel.getByTestId('financial-insurance-active')).toContainText('48.00')
    expect(errors).toEqual([])
  })
})
