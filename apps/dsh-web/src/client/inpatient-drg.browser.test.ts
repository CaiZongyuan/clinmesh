import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgPayerReviewListSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { archiveDrgBrowserPatient, createDrgBrowserPatient, expect, test } from '../../../web/e2e/inpatient-drg.fixture.ts'
import { buildInpatientDrgFixture } from './inpatient-drg.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`inpatient DRG React ${version}`, () => {
  let artifact: Awaited<ReturnType<typeof buildInpatientDrgFixture>>
  test.beforeAll(async () => { test.setTimeout(120_000); artifact = await buildInpatientDrgFixture(version) })
  test('耗材预留和医保办核定审阅在 ShadowRoot 内保持焦点，窄屏可取消和提交', async ({ page, browserApp }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const s = await createDrgBrowserPatient(page, browserApp, '合成DRG Surface患者')
    const open = async () => {
      await page.route(`${browserApp.origin}/drg-contract`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
      await page.goto(`${browserApp.origin}/drg-contract`)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.setContent(`<!doctype html><html data-admission-id="${s.admissionId}"><head><style>${artifact.styles}</style></head><body><script>${artifact.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    }
    await open()
    const reserve = page.getByRole('region', { name: '治疗耗材预留', exact: true })
    await reserve.getByLabel('预留耗材', { exact: true }).click()
    await page.getByRole('option', { name: '合成演示缝合材料', exact: true }).click()
    await reserve.getByLabel('预留或释放理由', { exact: true }).fill('合成Surface长中文治疗预留说明，用于核对人工审阅中的数量与材料')
    await reserve.getByRole('button', { name: '审阅新增预留', exact: true }).click()
    const reservationDialog = page.getByRole('alertdialog', { name: '确认耗材预留变更', exact: true })
    await expect.poll(() => reservationDialog.evaluate(element => { const root = element.getRootNode(); return root instanceof ShadowRoot && element.contains(root.activeElement) })).toBe(true)
    const bounds = await reservationDialog.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.clientWidth, scroll: element.scrollWidth }))
    expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(390); expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1)
    await reservationDialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations).toHaveLength(0)
    await reserve.getByRole('button', { name: '审阅新增预留', exact: true }).click()
    await reservationDialog.getByRole('button', { name: '确认预留变更', exact: true }).click()
    await expect(reservationDialog).toBeHidden()
    expect(inpatientMaterialReservationListSchema.parse(await (await s.api.get(`${s.path}/drg/reservations`)).json()).reservations).toHaveLength(1)
    await archiveDrgBrowserPatient(s)
    await s.api.login('medical-insurance')
    await open()
    const payer = page.getByRole('region', { name: '医保办 DRG 复核', exact: true })
    await payer.getByLabel('模拟核定复核说明', { exact: true }).fill('合成Surface归档费用与支付参数复核')
    await payer.getByRole('button', { name: '审阅模拟核定', exact: true }).click()
    const review = page.getByRole('alertdialog', { name: '确认 DRG 模拟核定', exact: true })
    await expect(review).toContainText('模拟核定支付 ¥3,000.00')
    await expect.poll(() => review.evaluate(element => { const root = element.getRootNode(); return root instanceof ShadowRoot && element.contains(root.activeElement) })).toBe(true)
    const payerBounds = await review.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.clientWidth, scroll: element.scrollWidth }))
    expect(payerBounds.left).toBeGreaterThanOrEqual(0); expect(payerBounds.right).toBeLessThanOrEqual(390); expect(payerBounds.scroll).toBeLessThanOrEqual(payerBounds.width + 1)
    await review.getByRole('button', { name: '提交模拟核定', exact: true }).click()
    await expect(review).toBeHidden()
    expect(inpatientDrgPayerReviewListSchema.parse(await (await s.api.get(`${s.path}/drg/payer-reviews`)).json()).reviews).toHaveLength(1)
    expect(errors).toEqual([])
  })
})
